/* --------------------------------------------------------------------------------------------
 * MIT License
 * Copyright (c) 2019 Henrik Bohlin
 * Full license text can be found in /LICENSE or at https://opensource.org/licenses/MIT.
 * ------------------------------------------------------------------------------------------ */
'use strict';
import * as path from 'path';
import vscode = require('vscode');
import { workspace, ExtensionContext, window } from 'vscode';
import util = require('util');
import * as fs from 'fs';
const exec = util.promisify(require('child_process').exec);

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    DiagnosticSeverity,
} from 'vscode-languageclient';

let client: LanguageClient;

enum LanguageServerBinary {
    embedded,
    user,
    systemPath,
    docker,
}

const HOMEDIR = require('os')
    .homedir()
    .replace(/\\/g, '/');
const CONFFILE = 'vhdl_ls.toml';
const HOMECONF = path.join(HOMEDIR, '.' + CONFFILE);
const languageServerBinaryName = 'vhdl_ls';
const isWindows = process.platform === 'win32';

export async function activate(context: ExtensionContext) {
    // Default configuration
    if (!fs.existsSync(HOMECONF)) {
        console.log('.' + CONFFILE + ' not found in user HOME');
        writeDefaultConfig(context);
    }

    // Get language server configuration and command to start server
    let languageServerBinary = vscode.workspace
        .getConfiguration()
        .get('vhdlls.languageServer');
    let lsBinary = languageServerBinary as keyof typeof LanguageServerBinary;
    let serverOptions: ServerOptions;
    switch (lsBinary) {
        case 'embedded':
            serverOptions = getServerOptionsEmbedded(context);
            console.log('Using embedded language server');
            break;

        case 'user':
            serverOptions = getServerOptionsUser(context);
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
            serverOptions = getServerOptionsEmbedded(context);
            console.log('Using language server from system path');
            break;
    }

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'vhdl' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files
            // contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
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
    context.subscriptions.push(languageServerDisposable);
    context.subscriptions.push(
        vscode.commands.registerCommand('vhdlls.restart', async () => {
            const MSG = 'Restarting VHDL LS';
            console.log(MSG);
            window.showInformationMessage(MSG);
            await client.stop();
            languageServerDisposable.dispose();
            languageServerDisposable = client.start();
            context.subscriptions.push(languageServerDisposable);
        })
    );
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
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
    let serverCommand = context.asAbsolutePath(
        path.join('server', languageServerBinaryName)
    );
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

function writeDefaultConfig(ctx: ExtensionContext) {
    const LIBDIR = ctx.asAbsolutePath('vhdl/libraries').replace(/\\/g, '/');
    console.log('Writing standard configuration to ' + HOMECONF);
    let conf = [
        `[libraries]`,
        `std.files = [`,
        `    "${LIBDIR}/std_2008/*.vhd",`,
        `]`,
        `ieee.files = [`,
        `    "${LIBDIR}/ieee_2008/*.vhdl",`,
        `    "${LIBDIR}/synopsys/*.vhdl",`,
        `]\n`,
    ];
    fs.writeFileSync(HOMECONF, conf.join('\n'));
}
