# VHDL Language Server/Support
VHDL Language Server and Support for Visual Studio Code.  

## Features
- VHDL-2008 parser
- Syntax checks
- Syntax highlighting
- Semantic analysis (see [Rust HDL](https://github.com/kraigher/rust_hdl#vhdl-language-server) for details)
- Library mapping

## Language Server
VHDL LS uses the [Rust HDL](https://github.com/kraigher/rust_hdl#vhdl-language-server) 
Language Server. Pre-compiled binaries are provided with the extension but it 
can also be loaded from either the system path or using Docker depending
on the value of the `vhdlls.languageServerBinary` property.
- `embedded`: Use the embedded binary.
- `systemPath`: Load `vhdl_ls` from path.
- `docker`: Use [docker image](https://hub.docker.com/r/kraigher/vhdl_ls)
 (NOTE: Support for docker is not yet available on Windows)  

For instructions on compiling the language server, see 
[Rust HDL](https://github.com/kraigher/rust_hdl)

## Configuration
The language server uses a configuration file in the [TOML](https://github.com/toml-lang/toml) format named `vhdl_ls.toml`.
The file contains the library mapping of all files within the project. Files outside of the project without library mapping are checked for syntax errors only.

`vhdl_ls` will load configuration files in the following order of priority (first to last):
1. A file named `.vhdl_ls.toml` in the user home folder.
2. A file name from the `VHDL_LS_CONFIG` environment variable.
3. A file named `vhdl_ls.toml` in the workspace root.

Settings in later files overwrites those from previously loaded files.

**Example vhdl_ls.toml**

```toml
# File names are either absolute or relative to the parent folder of the
# vhdl_ls.toml file and supports glob-style patterns.
[libraries]
lib2.files = [
  'pkg2.vhd',
  'src/**/*.vhd',
]
lib1.files = [
  'pkg1.vhd',
  'tb_ent.vhd',
]
```

## Syntax coloring
Syntax coloring is based on the textmate [vhdl.tmbundle](https://github.com/textmate/vhdl.tmbundle)  

## Licenses
The VSCode extension `VHDL LS` is available under the MIT license.

The [Rust HDL](https://github.com/kraigher/rust_hdl#vhdl-language-server) 
VHDL language server is available under the Mozilla Public
License, v. 2.0.