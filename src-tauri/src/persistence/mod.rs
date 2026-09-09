//! 持久化边界：TS 侧通过本模块的命令访问文件系统（设计 §6.1/§6.2）。
//! M2 起全部命令只接受相对路径，根由激活 Workspace 解析（§6.3）。

pub mod document;
pub mod error;
pub mod paths;
pub mod recent;
pub mod store;
pub mod util;
pub mod workspace;
