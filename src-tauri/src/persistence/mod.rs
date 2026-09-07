//! M1 持久化边界：TS 侧通过本模块的命令访问文件系统（设计 §6.1/§6.2）。

pub mod document;
pub mod error;
pub mod paths;
