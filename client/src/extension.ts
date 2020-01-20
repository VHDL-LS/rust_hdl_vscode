/* ------------------------------------------------------------------------------------------
 * MIT License
 * Copyright (c) 2020 Henrik Bohlin
 * Full license text can be found in /LICENSE or at https://opensource.org/licenses/MIT.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import extract = require('extract-zip');
import * as fs from 'fs-extra';
import fetch from 'node-fetch';
import Octokit = require('@octokit/rest');
import * as path from 'path';
import semver = require('semver');
import vscode = require('vscode');
import { workspace, ExtensionContext, window } from 'vscode';
import util = require('util');
import * as lockfile from 'proper-lockfile';
const exec = util.promisify(require('child_process').exec);

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from 'vscode-languageclient';

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
    : 'vhdl_ls-x86_64-unknown-linux-gnu';
const languageServerBinaryName = 'vhdl_ls';
let languageServer: string;

export async function activate(ctx: ExtensionContext) {
    const languageServerDir = ctx.asAbsolutePath(
        path.join('server', 'vhdl_ls')
    );
    let languageServerVersion = embeddedVersion(languageServerDir);
    if (languageServerVersion == '0.0.0') {
        await getLatestLanguageServer(ctx).catch(err => console.log(err));
        languageServerVersion = embeddedVersion(languageServerDir);
    }
    console.log(languageServerVersion);
    languageServer = path.join(
        'server',
        'vhdl_ls',
        languageServerVersion,
        languageServerName,
        'bin',
        languageServerBinaryName + (isWindows ? '.exe' : '')
    );

    // Get language server configuration and command to start server
    let languageServerBinary = vscode.workspace
        .getConfiguration()
        .get('vhdlls.languageServer');
    let lsBinary = languageServerBinary as keyof typeof LanguageServerBinary;
    let serverOptions: ServerOptions;
    switch (lsBinary) {
        case 'embedded':
            serverOptions = getServerOptionsEmbedded(ctx);
            console.log('Using embedded language server');
            break;

        case 'user':
            serverOptions = getServerOptionsUser(ctx);
            console.log('Using user specified language server');
            console.log(serverOptions);
            break;

        case 'systemPath':
            serverOptions = getServerOptionsSystemPath();
            console.log('Running language server from path');
            break;

        case 'docker':
            serverOptions = await getServerOptionsDocker();
            console.log('Using vhdl_ls from Docker Hub');
            break;

        default:
            serverOptions = getServerOptionsEmbedded(ctx);
            console.log('Using embedded language server (default)');
            break;
    }

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'vhdl' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher(
                path.join(
                    vscode.workspace.workspaceFolders[0].uri.fsPath,
                    'vhdl_ls.toml'
                )
            ),
        },
    };

    // Create the language client
    client = new LanguageClient(
        'vhdl_ls',
        'VHDL LS',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    let languageServerDisposable = client.start();

    // Register command to restart language server
    ctx.subscriptions.push(languageServerDisposable);
    ctx.subscriptions.push(
        vscode.commands.registerCommand('vhdlls.restart', async () => {
            const MSG = 'Restarting VHDL LS';
            console.log(MSG);
            window.showInformationMessage(MSG);
            await client.stop();
            languageServerDisposable.dispose();
            languageServerDisposable = client.start();
            ctx.subscriptions.push(languageServerDisposable);
        })
    );

    console.log('Checking for updates');
    lockfile
        .lock(ctx.asAbsolutePath('server'), {
            lockfilePath: ctx.asAbsolutePath(path.join('server', '.lock')),
        })
        .then((release: () => void) => {
            getLatestLanguageServer(ctx)
                .catch(err => {
                    console.log(err);
                })
                .finally(() => {
                    console.log('Language server update finished.');
                    return release();
                });
        });

    console.log('Started');
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
                            console.log(err);
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
    console.log(`Pulling '${image}'`);
    console.log(pullCmd);
    const { stdout, stderr } = await exec(pullCmd);
    console.log(stdout);
    console.log(stderr);

    console.log(vscode.workspace.workspaceFolders[0]);
    let wsPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
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
    console.log(serverCommand);
    console.log(serverArgs);
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

function getServerOptionsUser(context: ExtensionContext) {
    let serverCommand: string = vscode.workspace
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
    owner: 'kraigher',
    repo: 'rust_hdl',
};

async function getLatestLanguageServer(ctx: ExtensionContext) {
    // Get current and latest version
    const octokit = new Octokit({ userAgent: 'rust_hdl_vscode' });
    let latestRelease = await octokit.repos.getLatestRelease({
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
    console.log(`Current vhdl_ls version: ${current}`);
    console.log(`Latest vhdl_ls version: ${latest}`);

    // Download new version if available
    if (semver.prerelease(latest)) {
        console.log('Latest is pre-release, skipping');
    } else if (semver.lte(latest, current)) {
        console.log('Language server is already up-to-date');
    } else {
        const languageServerAssetName = languageServerName + '.zip';
        let browser_download_url = latestRelease.data.assets.filter(
            asset => asset.name == languageServerAssetName
        )[0].browser_download_url;
        if (browser_download_url.length == 0) {
            throw new Error(
                `No asset with name ${languageServerAssetName} in release.`
            );
        }

        console.log('Fetching ' + browser_download_url);
        let download = await fetch(browser_download_url);
        if (download.status != 200) {
            throw new Error('Download returned status != 200');
        }
        const languageServerAsset = ctx.asAbsolutePath(
            path.join('server', 'install', latest, languageServerAssetName)
        );
        console.log(`Writing ${languageServerAsset}`);
        if (!fs.existsSync(path.dirname(languageServerAsset))) {
            fs.mkdirSync(path.dirname(languageServerAsset), {
                recursive: true,
            });
        }

        await new Promise((resolve, reject) => {
            const dest = fs.createWriteStream(languageServerAsset, {
                autoClose: true,
            });
            download.body.pipe(dest);
            dest.on('finish', () => {
                console.log('Server download complete');
                resolve();
            });
            dest.on('error', (err: any) => {
                console.log('Server download error');
                reject(err);
            });
        });

        await new Promise((resolve, reject) => {
            const targetDir = ctx.asAbsolutePath(
                path.join('server', 'vhdl_ls', latest)
            );
            console.log(`Extracting ${languageServerAsset} to ${targetDir}`);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            extract(languageServerAsset, { dir: targetDir }, err => {
                try {
                    fs.removeSync(
                        ctx.asAbsolutePath(path.join('server', 'install'))
                    );
                } catch {}
                if (err) {
                    console.log('Error when extracting server');
                    console.log(err);
                    try {
                        fs.removeSync(targetDir);
                    } catch {}
                    reject(err);
                } else {
                    console.log('Server extracted');
                    resolve();
                }
            });
        });
    }
    return Promise.resolve();
}
