# Project setup
1. Install `npm`
2. Install `vsce` via `npm install -g vsce`
3. Run `npm install` at the project root to install dependencies.
4. Compile the language server according to https://github.com/kraigher/rust_hdl.  
To debug the language server with `"vhdlls.languageServer = embedded"` the `vhdl_ls` binary must be placed in the ./server directory of the extension project.

# Client
The source for the client is located at ./client/src/extension.ts.  
Snippets are defined in ./snippets
Syntaxes are defined in ./syntaxes  

# Debugging
Press `F5` to start debugging.

# Packaging a VSIX
A VSIX file is a local package of the extension which can be installed into VSCode. To generate a `VSIX` package, run `vsce package` at the project root. The VSIX `vhdl-ls-*.vsix` is generated at the project root.
The VSIX can be installed by:
- Command line: `code --install-extension vhdl-ls-*.vsix`
- Via GUI: https://code.visualstudio.com/docs/editor/extension-gallery#_install-from-a-vsix 

