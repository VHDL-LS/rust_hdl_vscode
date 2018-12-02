/* --------------------------------------------------------------------------------------------
* MIT License
* Copyright (c) 2018 Henrik Bohlin
* Full license text can be found in /LICENSE or at https://opensource.org/licenses/MIT.
* ------------------------------------------------------------------------------------------ */
'use strict';
import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions
} from 'vscode-languageclient';

let client: LanguageClient;

export function activate(context: ExtensionContext) {

    // Get the path to the language server executable
    const serverExecutableDir = 'server';
    const serverExecutable = process.platform === 'win32'? 
        context.asAbsolutePath(path.join(serverExecutableDir, 'vhdl_ls.exe')) :
        context.asAbsolutePath(path.join(serverExecutableDir, 'vhdl_ls'));

    let serverOptions: ServerOptions = {
        run: {
            command: serverExecutable
        },
        debug: {
            command: serverExecutable
        }
    };

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'vhdl' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
        }
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        'languageServerExample',
        'Language Server Example',
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