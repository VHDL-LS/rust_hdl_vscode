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
const exec = util.promisify(require('child_process').exec);

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    DiagnosticSeverity
} from 'vscode-languageclient';

let client: LanguageClient;

enum LanguageServerBinary {
    Embedded, SystemPath, Docker
}

const languageServerBinaryName = 'vhdl_ls';

export async function activate(context: ExtensionContext) {
    
    let languageServerBinary = vscode.workspace.getConfiguration().get('vhdlLs.languageServerBinary');
    let lsBinary = languageServerBinary as keyof typeof LanguageServerBinary;
    const isWindows = process.platform === "win32";

    let serverCommand  = context.asAbsolutePath(path.join('server', 'vhdl_ls'));
    let serverArgs = [];
    
    if (isWindows && lsBinary == "Docker") {
        window.showWarningMessage("Docker language server not supported on Windows, using system path instead");
        lsBinary = "SystemPath";
    }
    // TODO: If extensions is selected and no vhdl_ls found in /server, use system path

    let serverOptions: ServerOptions;
    switch(lsBinary) {
        case "Docker": 
            serverOptions = await getServerOptionsDocker(); 
            console.log('Using Docker image for language server');
            break;
        
        case "Embedded": 
            serverOptions = getServerOptionsExtension(context);
            console.log('Using local language server');
            break;

        default: 
            serverOptions = getServerOptionsDefault();
            console.log('Using language server from system path');
            break;
    }


    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'vhdl' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
        }
    };

    // Create the language client
    client = new LanguageClient(
        'vhdl_ls',
        'VHDL LS',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}


async function getServerOptionsDocker() {
    const dockerImage = 'kraigher/vhdl_ls:latest';
    const { stdout, stderr } = await exec("docker pull " + dockerImage);
    console.log(stdout);
    console.log(stderr);
    let serverCommand = 'docker';
    let serverArgs = ['run', '-i', '-a', 'stdin', '-a', 'stdout', '-a', 'stderr', '--rm'];
    let wsFolders : any = vscode.workspace.workspaceFolders;
    let pwdIsSet = false;
    if (wsFolders) {
        wsFolders.forEach(path => {
            let folder : vscode.WorkspaceFolder = (path as vscode.WorkspaceFolder);
            console.log(folder.uri);
            let fsPath = folder.uri.path;
            let mountPath = folder.uri.path;
            if (!pwdIsSet) {
                pwdIsSet = true;
                serverArgs.push('-w');
                serverArgs.push(mountPath);
            }
            serverArgs.push('-v');
            serverArgs.push(fsPath + ':' + mountPath + ':ro');
            
        });
    }
    serverArgs.push(dockerImage);
    console.log(serverCommand);
    console.log(serverArgs);
    let serverOptions: ServerOptions = {
        run: {
            command: serverCommand,
            args   : serverArgs
        },
        debug: {
            command: serverCommand,
            args   : serverArgs
        }
    };
    return serverOptions;
}

function getServerOptionsExtension(context: ExtensionContext) {
    let serverCommand = context.asAbsolutePath(path.join('server', languageServerBinaryName));
    let serverOptions: ServerOptions = {
        run: {
            command: serverCommand
        },
        debug: {
            command: serverCommand
        }
    };
    return serverOptions;
}

function getServerOptionsDefault() {
    let serverCommand = languageServerBinaryName;
    let serverOptions: ServerOptions = {
        run: {
            command: serverCommand
        },
        debug: {
            command: serverCommand
        }
    };
    return serverOptions;
}