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
import { ExtensionContext, window, workspace, commands } from 'vscode';
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
    // Get language server configuration and command to start server
    let languageServerBinary = workspace
        .getConfiguration()
        .get('vhdlls.languageServer');
    let lsBinary = languageServerBinary as keyof typeof LanguageServerBinary;
    let serverOptions: ServerOptions;
    switch (lsBinary) {
        case 'embedded':
            output.appendLine('Using embedded language server');
            let desiredVersionString: string = workspace
                .getConfiguration()
                .get('vhdlls.embeddedVersion');
            const languageServerDir = ctx.asAbsolutePath(
                path.join('server', 'vhdl_ls')
            );

            if (desiredVersionString === 'latest') {
                output.appendLine('Checking for updates...');
                lockfile
                    .lock(ctx.asAbsolutePath('server'), {
                        lockfilePath: ctx.asAbsolutePath(
                            path.join('server', '.lock')
                        ),
                    })
                    .then((release: () => void) => {
                        getLanguageServer(null, 60000, ctx)
                            .catch((err) => {
                                output.appendLine(err);
                            })
                            .finally(() => {
                                output.appendLine(
                                    'Language server update finished.'
                                );
                                return release();
                            });
                    });
            } else {
                let currentVersion = semver.coerce(
                    embeddedVersion(languageServerDir)
                );
                let desiredVersion = semver.coerce(desiredVersionString);
                if (desiredVersion !== currentVersion) {
                    await getLanguageServer(desiredVersionString, 60000, ctx);
                }
            }

            output.appendLine(
                'Checking for language server executable in ' +
                    languageServerDir
            );
            let languageServerVersion = embeddedVersion(languageServerDir);
            languageServer = path.join(
                'server',
                'vhdl_ls',
                languageServerVersion,
                languageServerName,
                'bin',
                languageServerBinaryName + (isWindows ? '.exe' : '')
            );
            serverOptions = getServerOptionsEmbedded(ctx);
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

async function getLanguageServer(
    versionTag: string | undefined,
    timeoutMs: number,
    ctx: ExtensionContext
) {
    // Get current and latest version
    let current = await getCurrentEmbeddedVersion(ctx);

    output.appendLine(`Current vhdl_ls version: ${current}`);

    const { release, version } = await getReleaseAndVersion(
        versionTag,
        current
    );

    const languageServerAsset = await downloadLanguageServer(
        release,
        timeoutMs,
        ctx,
        version
    );

    await installLanguageServer(ctx, version, languageServerAsset);
}

async function installLanguageServer(
    ctx: ExtensionContext,
    version: string,
    languageServerAsset: string
) {
    await new Promise<void>((resolve, reject) => {
        const targetDir = ctx.asAbsolutePath(
            path.join('server', 'vhdl_ls', version)
        );
        output.appendLine(`Extracting ${languageServerAsset} to ${targetDir}`);
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

async function downloadLanguageServer(
    release: any,
    timeoutMs: number,
    ctx: ExtensionContext,
    version: string
) {
    const languageServerAssetName = languageServerName + '.zip';
    let browser_download_url = release.data.assets.filter(
        (asset: { name: string }) => asset.name == languageServerAssetName
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
        path.join('server', 'install', version, languageServerAssetName)
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
    return languageServerAsset;
}

/// Returns the current embedded language server version as string.
async function getCurrentEmbeddedVersion(
    ctx: ExtensionContext
): Promise<string> {
    let current: string;
    if (languageServer) {
        let languageServerPath = ctx.asAbsolutePath(languageServer);
        let { stdout } = await exec(`"${languageServerPath}" --version`);
        current = semver.valid(semver.coerce(stdout.split(' ', 2)[1]));
    } else {
        current = '0.0.0';
    }
    return current;
}

async function getReleaseAndVersion(
    versionTag: string | undefined,
    current: string
): Promise<{
    release: any;
    version: string;
}> {
    const octokit = new Octokit({ userAgent: 'rust_hdl_vscode' });
    let release: any;
    let version: string;
    if (!versionTag) {
        release = await octokit.rest.repos.getLatestRelease({
            owner: rustHdl.owner,
            repo: rustHdl.repo,
        });
        version = semver.valid(semver.coerce(release.data.name));
        if (semver.prerelease(version)) {
            output.appendLine('Latest version is pre-release, skipping');
            return;
        } else if (semver.lte(version, current)) {
            output.appendLine('Language server is up-to-date');
            return;
        }
    } else {
        release = await octokit.rest.repos.getReleaseByTag({
            owner: rustHdl.owner,
            repo: rustHdl.repo,
            tag: versionTag,
        });
        version = semver.valid(semver.coerce(release.data.name));
    }
    if (release.status != 200) {
        throw new Error('Status != 200 when getting latest release');
    }
    return {
        release: release,
        version: version,
    };
}
