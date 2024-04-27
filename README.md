# VHDL Language Server/Support
VHDL Language Server and Support for Visual Studio Code.  

### Features
- Live syntax and type checking 
- Finds missing and duplicate declarations
- Goto-definition/declaration (also in presence of overloading)
- Find-all-references (also in presence of overloading)
- Goto-implementation
  - From component declaration to matching entity by default binding
  - From entity to matching component declaration by default binding
- Hovering symbols reveals more information
- Renaming symbols
- Finding workspace symbols
- Viewing/finding document symbols

## Configuration
The language server needs to know the library mapping of the VHDL files in the project, for this purpose it reads a configuration file in the [TOML](https://github.com/toml-lang/toml) format named `vhdl_ls.toml`.
The file contains the library mapping of all files within the project and should be located in the workspace root. 
Files outside of the project without library mapping are checked for syntax errors only.  
  
`vhdl_ls` will load configuration files in the following order of priority (first to last):
1. A file named `.vhdl_ls.toml` in the user home folder.
2. A file name from the `VHDL_LS_CONFIG` environment variable.
3. A file named `vhdl_ls.toml` in the workspace root.

Library definitions in later files redefines those from previously loaded files.

**Example vhdl_ls.toml**

```toml
# File names are either absolute or relative to the parent folder of the
# vhdl_ls.toml file and supports glob-style patterns.

[libraries]

# Defines library lib2
lib2.files = [
  'pkg2.vhd',
  'src/**/*.vhd',
]

# Defines library lib1
lib1.files = [
  'pkg1.vhd',
  'tb_ent.vhd',
]

# Libraries can be marked as third-party to disable some analysis warnings, such as unused declarations
UNISIM.files = [
  'C:\Xilinx\Vivado\2023.1\data\vhdl\src\unisims\unisim_VCOMP.vhd',
]
UNISIM.is_third_party = true
```

### Non-project files
By default, files that are not part of the project are added and analyzed as part of an anonymous library. You can disable this behaviour by changing the `vhdlls.nonProjectFiles` setting from `analyze` to `ignore`.

## Technology under the hood
This extension is based on the [VHDL-LS](https://github.com/VHDL-LS/rust_hdl#vhdl-language-server) Language Server. 
Pre-compiled binaries for Linux and Windows are provided with the extension.

The server can also be loaded from either the system path or Docker depending
on the value of the `vhdlls.languageServer` property.
- `embedded`: Use the embedded binary.
- `user`: Use path provided by user in `vhdlls.languageServerUserPath` property.
- `systemPath`: Run `vhdl_ls` from path.
- `docker`: Use [docker image](https://hub.docker.com/r/kraigher/vhdl_ls) (Only supports files below workspace root)

**NOTE:** On Linux, it may be necessary to set -x on the vhdl_ls binary.  

## Issues
Issues related to the extension can be reported at [VHDL LS - VSCode](https://github.com/Bochlin/rust_hdl_vscode) repository.

Issues related to the VHDL language support and language server featuresshould be reported directly to [VHDL-LS](https://github.com/VHDL-LS/rust_hdl#vhdl-language-server)

[![Chat](https://img.shields.io/matrix/VHDL-LS:matrix.org)](https://matrix.to/#/#VHDL-LS:matrix.org)

## Syntax coloring
Syntax coloring is based on the textmate [vhdl.tmbundle](https://github.com/textmate/vhdl.tmbundle)  

## Licenses
The VSCode extension is available under the MIT license.

The [VHDL-LS](https://github.com/VHDL-LS/rust_hdl#vhdl-language-server)
VHDL language server is available under the Mozilla Public
License, v. 2.0.
