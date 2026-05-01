/* ------------------------------------------------------------------------------------------
 * MIT License
 * Copyright (c) 2020 Henrik Bohlin
 * Full license text can be found in /LICENSE or at https://opensource.org/licenses/MIT.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import extract = require('extract-zip');
import * as fs from 'fs-extra';
import { Octokit } from 'octokit';
import * as path from 'path';
import semver = require('semver');
import {
    ConfigurationTarget,
    ExtensionContext,
    EventEmitter,
    Event,
    QuickPickItem,
    QuickPickItemKind,
    Range,
    Position,
    ProviderResult,
    ThemeIcon,
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    window,
    workspace,
    commands,
} from 'vscode';
import util = require('util');
import * as lockfile from 'proper-lockfile';
const exec = util.promisify(require('child_process').exec);
const output = window.createOutputChannel('VHDL-LS Client');
const traceOutputChannel = window.createOutputChannel('VHDL-LS Trace');
import { Readable } from 'stream';

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient;

enum LanguageServerBinary {
    embedded,
    user,
    systemPath,
    docker,
}

const isWindows = process.platform === 'win32';
const languageServerName = isWindows
    ? 'vhdl_ls-x86_64-pc-windows-msvc'
    : 'vhdl_ls-x86_64-unknown-linux-musl';
const languageServerBinaryName = 'vhdl_ls';
let languageServer: string;

export async function activate(ctx: ExtensionContext) {
    const languageServerDir = ctx.asAbsolutePath(
        path.join('server', 'vhdl_ls')
    );
    output.appendLine(
        'Checking for language server executable in ' + languageServerDir
    );
    let languageServerVersion = embeddedVersion(languageServerDir);
    if (languageServerVersion == '0.0.0') {
        output.appendLine('No language server installed');
        window.showInformationMessage('Downloading language server...');
        await getLatestLanguageServer(60000, ctx);
        languageServerVersion = embeddedVersion(languageServerDir);
    } else {
        output.appendLine('Found version ' + languageServerVersion);
    }
    languageServer = path.join(
        'server',
        'vhdl_ls',
        languageServerVersion,
        languageServerName,
        'bin',
        languageServerBinaryName + (isWindows ? '.exe' : '')
    );

    // Get language server configuration and command to start server

    let languageServerBinary = workspace
        .getConfiguration()
        .get('vhdlls.languageServer');
    let lsBinary = languageServerBinary as keyof typeof LanguageServerBinary;
    let serverOptions: ServerOptions;
    switch (lsBinary) {
        case 'embedded':
            serverOptions = getServerOptionsEmbedded(ctx);
            output.appendLine('Using embedded language server');
            break;

        case 'user':
            serverOptions = getServerOptionsUser(ctx);
            output.appendLine('Using user specified language server');
            break;

        case 'systemPath':
            serverOptions = getServerOptionsSystemPath();
            output.appendLine('Running language server from path');
            break;

        case 'docker':
            serverOptions = await getServerOptionsDocker();
            output.appendLine('Using vhdl_ls from Docker Hub');
            break;

        default:
            serverOptions = getServerOptionsEmbedded(ctx);
            output.appendLine('Using embedded language server (default)');
            break;
    }

    let librariesLocation = workspace
        .getConfiguration()
        .get('vhdlls.standardLibraries');

    if (lsBinary !== 'docker' && librariesLocation) {
        const args = ['--libraries', librariesLocation as string];
        serverOptions.run.args = args;
        serverOptions.debug.args = args;
    }

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'vhdl' }],
        initializationOptions: () => workspace.getConfiguration('vhdlls'),
        traceOutputChannel,
    };
    if (workspace.workspaceFolders) {
        clientOptions.synchronize = {
            fileEvents: workspace.createFileSystemWatcher(
                path.join(
                    workspace.workspaceFolders[0].uri.fsPath,
                    'vhdl_ls.toml'
                )
            ),
        };
    }

    // Create the language client
    client = new LanguageClient(
        'vhdlls',
        'VHDL LS',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    await client.start();

    // Register command to restart language server
    ctx.subscriptions.push(
        commands.registerCommand('vhdlls.restart', async () => {
            const MSG = 'Restarting VHDL LS';
            output.appendLine(MSG);
            window.showInformationMessage(MSG);
            await client.restart();
        })
    );

    // Register design-hierarchy view + commands.
    const hierarchyProvider = new HierarchyProvider(() => client, output);
    ctx.subscriptions.push(
        window.registerTreeDataProvider('vhdlHierarchy', hierarchyProvider)
    );
    const pickAndApply = async () => {
        const top = await pickTopEntity(() => client, output);
        if (top) {
            hierarchyProvider.setTop(top);
            void persistTopEntity(top, output);
        }
    };
    ctx.subscriptions.push(
        commands.registerCommand('vhdlls.showHierarchy', pickAndApply)
    );
    ctx.subscriptions.push(
        commands.registerCommand('vhdlls.setHierarchyTop', pickAndApply)
    );
    ctx.subscriptions.push(
        commands.registerCommand('vhdlls.refreshHierarchy', () => {
            hierarchyProvider.refresh();
        })
    );

    // If a default top entity is configured, load the hierarchy on startup.
    const configuredTop = workspace
        .getConfiguration()
        .get<string>('vhdlls.topEntity');
    if (configuredTop) {
        const parsed = parseTopEntity(configuredTop);
        if (parsed) {
            hierarchyProvider.setTop(parsed);
        }
    }

    output.appendLine('Checking for updates...');
    lockfile
        .lock(ctx.asAbsolutePath('server'), {
            lockfilePath: ctx.asAbsolutePath(path.join('server', '.lock')),
        })
        .then((release: () => void) => {
            getLatestLanguageServer(60000, ctx)
                .catch((err) => {
                    output.appendLine(err);
                })
                .finally(() => {
                    output.appendLine('Language server update finished.');
                    return release();
                });
        });

    output.appendLine('Language server started');
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

function embeddedVersion(languageServerDir: string): string {
    try {
        return fs
            .readdirSync(languageServerDir)
            .reduce((version: string, dir: string) => {
                if (semver.gt(dir, version)) {
                    fs.remove(path.join(languageServerDir, version)).catch(
                        (err: any) => {
                            output.appendLine(err);
                        }
                    );
                    return dir;
                } else {
                    return version;
                }
            }, '0.0.0');
    } catch {
        return '0.0.0';
    }
}

async function getServerOptionsDocker() {
    const image = 'kraigher/vhdl_ls:latest';
    let pullCmd = 'docker pull ' + image;
    output.appendLine(`Pulling '${image}'`);
    output.appendLine(pullCmd);
    const { stdout, stderr } = await exec(pullCmd);
    output.append(stdout);
    output.append(stderr);

    let wsPath = workspace.workspaceFolders[0].uri.fsPath;
    let mountPath = wsPath;
    if (isWindows) {
        wsPath = wsPath.replace(/\\/g, '/');
        mountPath = '/' + wsPath.replace(':', '');
    }

    let serverCommand = 'docker';
    let serverArgs = [
        'run',
        '-i',
        '-a',
        'stdin',
        '-a',
        'stdout',
        '-a',
        'stderr',
        '--rm',
        '-w',
        mountPath,
        '-v',
        `${wsPath}:${mountPath}:ro`,
        image,
    ];
    let serverOptions: ServerOptions = {
        run: {
            command: serverCommand,
            args: serverArgs,
        },
        debug: {
            command: serverCommand,
            args: serverArgs,
        },
    };
    return serverOptions;
}

function getServerOptionsEmbedded(context: ExtensionContext) {
    let serverCommand = context.asAbsolutePath(languageServer);
    let serverOptions: ServerOptions = {
        run: {
            command: serverCommand,
        },
        debug: {
            command: serverCommand,
        },
    };
    return serverOptions;
}

function getServerOptionsUser(_: ExtensionContext) {
    let serverCommand: string = workspace
        .getConfiguration()
        .get('vhdlls.languageServerUserPath');
    let serverOptions: ServerOptions = {
        run: {
            command: serverCommand,
        },
        debug: {
            command: serverCommand,
        },
    };
    return serverOptions;
}

function getServerOptionsSystemPath() {
    let serverCommand = languageServerBinaryName;
    let serverOptions: ServerOptions = {
        run: {
            command: serverCommand,
        },
        debug: {
            command: serverCommand,
        },
    };
    return serverOptions;
}

const rustHdl = {
    owner: 'VHDL-LS',
    repo: 'rust_hdl',
};

async function getLatestLanguageServer(
    timeoutMs: number,
    ctx: ExtensionContext
) {
    // Get current and latest version
    const octokit = new Octokit({ userAgent: 'rust_hdl_vscode' });
    let latestRelease = await octokit.rest.repos.getLatestRelease({
        owner: rustHdl.owner,
        repo: rustHdl.repo,
    });
    if (latestRelease.status != 200) {
        throw new Error('Status 200 return when getting latest release');
    }
    let current: string;
    if (languageServer) {
        let { stdout, stderr } = await exec(
            `"${ctx.asAbsolutePath(languageServer)}" --version`
        );
        current = semver.valid(semver.coerce(stdout.split(' ', 2)[1]));
    } else {
        current = '0.0.0';
    }

    let latest = semver.valid(semver.coerce(latestRelease.data.name));
    output.appendLine(`Current vhdl_ls version: ${current}`);
    output.appendLine(`Latest vhdl_ls version: ${latest}`);

    // Download new version if available
    if (semver.prerelease(latest)) {
        output.appendLine('Latest version is pre-release, skipping');
    } else if (semver.lte(latest, current)) {
        output.appendLine('Language server is up-to-date');
    } else {
        const languageServerAssetName = languageServerName + '.zip';
        let browser_download_url = latestRelease.data.assets.filter(
            (asset) => asset.name == languageServerAssetName
        )[0].browser_download_url;
        if (browser_download_url.length == 0) {
            throw new Error(
                `No asset with name ${languageServerAssetName} in release.`
            );
        }

        output.appendLine('Fetching ' + browser_download_url);
        const abortController = new AbortController();
        setTimeout(() => {
            abortController.abort();
        }, timeoutMs);
        let download = await fetch(browser_download_url, {
            signal: abortController.signal,
        }).catch((err) => {
            output.appendLine(err);
            throw new Error(
                `Language server download timed out after ${timeoutMs.toFixed(
                    2
                )} seconds.`
            );
        });
        if (download.status != 200) {
            throw new Error('Download returned status != 200');
        }
        const languageServerAsset = ctx.asAbsolutePath(
            path.join('server', 'install', latest, languageServerAssetName)
        );
        output.appendLine(`Writing ${languageServerAsset}`);
        if (!fs.existsSync(path.dirname(languageServerAsset))) {
            fs.mkdirSync(path.dirname(languageServerAsset), {
                recursive: true,
            });
        }

        await new Promise<void>((resolve, reject) => {
            const dest = fs.createWriteStream(languageServerAsset, {
                autoClose: true,
            });
            Readable.fromWeb(download.body).pipe(dest);
            dest.on('finish', () => {
                output.appendLine('Server download complete');
                resolve();
            });
            dest.on('error', (err: any) => {
                output.appendLine('Server download error');
                reject(err);
            });
        });

        await new Promise<void>((resolve, reject) => {
            const targetDir = ctx.asAbsolutePath(
                path.join('server', 'vhdl_ls', latest)
            );
            output.appendLine(
                `Extracting ${languageServerAsset} to ${targetDir}`
            );
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            extract(languageServerAsset, { dir: targetDir })
                .then(() => {
                    output.appendLine(`Server extracted to ${targetDir}`);
                    resolve();
                })
                .catch((err) => {
                    output.appendLine('Error when extracting server');
                    output.appendLine(err);
                    try {
                        fs.removeSync(targetDir);
                    } catch (err) {
                        output.appendLine(`Cannot remove ${targetDir}: ${err}`);
                    }
                    reject(err);
                })
                .finally(() => {
                    try {
                        fs.removeSync(
                            ctx.asAbsolutePath(path.join('server', 'install'))
                        );
                    } catch (err) {
                        output.appendLine(
                            `Cannot remove ${ctx.asAbsolutePath(
                                path.join('server', 'install')
                            )}: ${err}`
                        );
                    }
                });
        });
    }
    return Promise.resolve();
}

// --- Design Hierarchy view ---

import type { OutputChannel } from 'vscode';

const HIERARCHY_REQUEST = 'vhdl/designHierarchy';
const HIERARCHY_CANDIDATES_REQUEST = 'vhdl/designHierarchyCandidates';
const LSP_METHOD_NOT_FOUND = -32601;

interface TopEntity {
    library: string;
    entity: string;
}

// Matches what comes off the wire (lsp_types::Location serialized as JSON):
// `uri` is a plain string, not a parsed vscode.Uri.
interface LspLocation {
    uri: string;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
}

interface HierarchyResponseNode {
    label: string | null;
    entity: string;
    architecture: string | null;
    kind: string;
    instanceLocation: LspLocation | null;
    entityLocation: LspLocation | null;
    notes: string[];
    children: HierarchyResponseNode[];
}

interface HierarchyCandidate {
    library: string;
    entity: string;
    depth: number;
    instanceCount: number;
    isRoot: boolean;
    entityLocation: LspLocation | null;
}

interface CandidatesResponse {
    candidates: HierarchyCandidate[];
}

type ClientGetter = () => LanguageClient;

function isMethodNotFound(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: number }).code === LSP_METHOD_NOT_FOUND
    );
}

function describeError(err: unknown, fallback: string): string {
    if (typeof err === 'object' && err !== null) {
        const e = err as { message?: string };
        if (e.message) {
            return e.message;
        }
    }
    if (typeof err === 'string' && err) {
        return err;
    }
    return fallback;
}

async function persistTopEntity(
    top: TopEntity,
    log: OutputChannel
): Promise<void> {
    const value = `${top.library}.${top.entity}`;
    const cfg = workspace.getConfiguration();
    const target = workspace.workspaceFolders
        ? ConfigurationTarget.Workspace
        : ConfigurationTarget.Global;
    try {
        await cfg.update('vhdlls.topEntity', value, target);
    } catch (err) {
        log.appendLine(`Could not persist vhdlls.topEntity: ${err}`);
    }
}

function parseTopEntity(input: string): TopEntity | undefined {
    const s = input.trim();
    if (!s) {
        return undefined;
    }
    const dot = s.indexOf('.');
    if (dot < 0) {
        return { library: 'work', entity: s };
    }
    const library = s.slice(0, dot).trim();
    const entity = s.slice(dot + 1).trim();
    if (!library || !entity) {
        return undefined;
    }
    return { library, entity };
}

async function fetchCandidates(
    getClient: ClientGetter,
    log: OutputChannel
): Promise<HierarchyCandidate[] | 'unsupported'> {
    try {
        const resp = await getClient().sendRequest<CandidatesResponse>(
            HIERARCHY_CANDIDATES_REQUEST,
            {}
        );
        return resp.candidates ?? [];
    } catch (err) {
        if (isMethodNotFound(err)) {
            return 'unsupported';
        }
        log.appendLine(
            `Failed to fetch hierarchy candidates: ${describeError(err, 'request failed')}`
        );
        return [];
    }
}

interface CandidatePickItem extends QuickPickItem {
    candidate?: TopEntity;
    customInput?: boolean;
}

async function pickTopEntity(
    getClient: ClientGetter,
    log: OutputChannel
): Promise<TopEntity | undefined> {
    const current = workspace
        .getConfiguration()
        .get<string>('vhdlls.topEntity');

    const fetched = await fetchCandidates(getClient, log);
    const candidates = fetched === 'unsupported' ? [] : fetched;
    if (fetched === 'unsupported') {
        window.showWarningMessage(
            'The active vhdl_ls does not support the hierarchy request. ' +
                'Please update vhdl_ls or set vhdlls.languageServerUserPath ' +
                'to a build that includes design-hierarchy support.'
        );
    }

    const roots = candidates.filter((c) => c.isRoot);
    const others = candidates.filter((c) => !c.isRoot);

    const items: CandidatePickItem[] = [];
    if (roots.length > 0) {
        items.push({
            label: 'Top candidates (no incoming instantiations)',
            kind: QuickPickItemKind.Separator,
        });
        for (const c of roots) {
            items.push(candidateItem(c));
        }
    }
    if (others.length > 0) {
        items.push({
            label: 'Other entities',
            kind: QuickPickItemKind.Separator,
        });
        for (const c of others) {
            items.push(candidateItem(c));
        }
    }
    items.push({
        label: '$(edit) Type a custom entity name...',
        description: 'library.entity',
        customInput: true,
    });

    return new Promise<TopEntity | undefined>((resolve) => {
        const qp = window.createQuickPick<CandidatePickItem>();
        qp.title = 'Select top entity for design hierarchy';
        qp.placeholder =
            candidates.length === 0
                ? 'No entities listed (project still analysing or unsupported). Type library.entity.'
                : 'Pick a candidate, or type library.entity';
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.items = items;
        if (current) {
            qp.value = current;
        }
        qp.ignoreFocusOut = true;

        qp.onDidAccept(() => {
            const picked = qp.selectedItems[0];
            const typed = qp.value.trim();

            let result: TopEntity | undefined;
            if (picked && picked.candidate) {
                result = picked.candidate;
            } else if (picked && picked.customInput) {
                result = parseTopEntity(typed);
            } else if (typed) {
                result = parseTopEntity(typed);
            }
            qp.hide();
            resolve(result);
        });
        qp.onDidHide(() => {
            qp.dispose();
            resolve(undefined);
        });
        qp.show();
    });
}

function candidateItem(c: HierarchyCandidate): CandidatePickItem {
    const path = `${c.library}.${c.entity}`;
    const icon = c.isRoot ? '$(symbol-class) ' : '$(symbol-module) ';
    const description = `depth ${c.depth}, ${c.instanceCount} instance${
        c.instanceCount === 1 ? '' : 's'
    }`;
    const detail = c.entityLocation
        ? Uri.parse(c.entityLocation.uri).fsPath
        : undefined;
    return {
        label: `${icon}${path}`,
        description,
        detail,
        candidate: { library: c.library, entity: c.entity },
    };
}

// --- Tree provider --------------------------------------------------------
//
// The tree shows two kinds of element: status messages (when there is no
// hierarchy to render) and real instantiation nodes. They render
// differently and have different child-iteration rules, so we model them as
// a discriminated union rather than overload one class.

type TreeElement =
    | { kind: 'status'; label: string; command?: string }
    | { kind: 'node'; node: HierarchyResponseNode };

class HierarchyProvider implements TreeDataProvider<TreeElement> {
    private top: TopEntity | undefined;
    private root: HierarchyResponseNode | undefined;
    private loadError: string | undefined;
    private unsupported = false;
    private loading = false;
    private readonly emitter = new EventEmitter<TreeElement | undefined>();
    readonly onDidChangeTreeData: Event<TreeElement | undefined> =
        this.emitter.event;

    constructor(
        private readonly getClient: ClientGetter,
        private readonly log: OutputChannel
    ) {}

    setTop(top: TopEntity): void {
        this.top = top;
        void this.reload();
    }

    refresh(): void {
        if (this.top) {
            void this.reload();
        }
    }

    private async reload(): Promise<void> {
        if (!this.top) {
            return;
        }
        this.loading = true;
        this.loadError = undefined;
        this.unsupported = false;
        this.root = undefined;
        this.emitter.fire(undefined);
        try {
            this.root = await this.getClient().sendRequest<HierarchyResponseNode>(
                HIERARCHY_REQUEST,
                { library: this.top.library, entity: this.top.entity }
            );
        } catch (err) {
            if (isMethodNotFound(err)) {
                this.unsupported = true;
            } else {
                this.loadError = describeError(err, 'request failed');
                this.log.appendLine(`Hierarchy request failed: ${this.loadError}`);
            }
        } finally {
            this.loading = false;
            this.emitter.fire(undefined);
        }
    }

    getTreeItem(element: TreeElement): TreeItem {
        return element.kind === 'status'
            ? buildStatusItem(element.label, element.command)
            : buildNodeItem(element.node);
    }

    getChildren(element?: TreeElement): ProviderResult<TreeElement[]> {
        if (!element) {
            return this.rootChildren();
        }
        if (element.kind === 'status') {
            return [];
        }
        return element.node.children.map((node) => ({ kind: 'node', node } as TreeElement));
    }

    private rootChildren(): TreeElement[] {
        if (this.unsupported) {
            return [
                {
                    kind: 'status',
                    label: 'vhdl_ls does not support design hierarchy. Update or point vhdlls.languageServerUserPath at a newer build.',
                },
            ];
        }
        if (!this.top) {
            return [
                {
                    kind: 'status',
                    label: 'Click to set top entity...',
                    command: 'vhdlls.setHierarchyTop',
                },
            ];
        }
        if (this.loading) {
            return [{ kind: 'status', label: 'Loading hierarchy...' }];
        }
        if (this.loadError) {
            return [{ kind: 'status', label: `Error: ${this.loadError}` }];
        }
        if (!this.root) {
            return [{ kind: 'status', label: 'No hierarchy loaded.' }];
        }
        return [{ kind: 'node', node: this.root }];
    }
}

function buildStatusItem(label: string, command?: string): TreeItem {
    const item = new TreeItem(label, TreeItemCollapsibleState.None);
    item.contextValue = 'status';
    if (command) {
        item.command = { command, title: label };
    }
    return item;
}

function buildNodeItem(node: HierarchyResponseNode): TreeItem {
    const primary = node.label ?? node.entity;
    const collapsible =
        node.children.length > 0
            ? TreeItemCollapsibleState.Expanded
            : TreeItemCollapsibleState.None;
    const item = new TreeItem(primary, collapsible);

    const arch = node.architecture ? `(${node.architecture})` : '';
    item.description = `${node.entity}${arch}`;
    item.tooltip =
        (node.label ? `${node.label} : ` : '') +
        `${node.entity}${arch}` +
        (node.notes.length ? `\n# ${node.notes.join('\n# ')}` : '');
    item.contextValue = node.kind;
    item.iconPath = iconForKind(node.kind);

    const target = node.instanceLocation ?? node.entityLocation;
    if (target) {
        item.command = {
            command: 'vscode.open',
            title: 'Open',
            arguments: [
                Uri.parse(target.uri),
                {
                    selection: new Range(
                        new Position(
                            target.range.start.line,
                            target.range.start.character
                        ),
                        new Position(
                            target.range.end.line,
                            target.range.end.character
                        )
                    ),
                },
            ],
        };
    }
    return item;
}

function iconForKind(kind: string): ThemeIcon {
    switch (kind) {
        case 'top':
            return new ThemeIcon('symbol-class');
        case 'unboundComponent':
            return new ThemeIcon('warning');
        case 'unresolved':
            return new ThemeIcon('question');
        case 'configuration':
            return new ThemeIcon('symbol-misc');
        default:
            return new ThemeIcon('symbol-module');
    }
}
