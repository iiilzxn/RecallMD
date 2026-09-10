//! 锚点行修复（§9.4 L354–L360 补充场景：显式用户操作）。
//! 三种动作都只动**用户明确选定的那一行**，其余 Markdown 保持原样；preview 返回
//! 单行差异；apply 走 save_document 安全保存（expectedHash CAS），落盘后由常规
//! reconcile/commit 收敛身份状态。

use serde::{Deserialize, Serialize};

use super::document::{read_document, save_document, SaveDocumentParams, SaveDocumentResult};
use super::error::{HostError, HostResult, PATH_REJECTED, VERIFY_FAILED};

/// 锚点行格式与 TS 引擎唯一来源（ids.ts）保持一致：全小写 UUIDv4
fn make_anchor_line(block_id: &str) -> String {
    format!("<!-- recall:block:{block_id} -->")
}

fn valid_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).map(|u| u.to_string() == s).unwrap_or(false)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum AnchorRepairOp {
    /// 副本换新 ID：把指定锚点行的 UUID 替换为新 UUID（§9.4 复制场景）
    DuplicateRekey {
        relative_path: String,
        block_id: String,
        expected_hash: String,
    },
    /// 丢失 ID 恢复：在指定行号（该块标题行）下方插入旧 ID 的锚点行（§9.4 丢失 ID
    /// 场景；插入后引擎重扫判定合法性）
    MissingReinsert {
        relative_path: String,
        block_id: String,
        line_index: usize,
        expected_hash: String,
    },
    /// 删除失效/错位注释行（§9.4 错误注释修复：只动选定行）
    MisplacedRemove {
        relative_path: String,
        block_id: String,
        expected_hash: String,
    },
}

impl AnchorRepairOp {
    pub fn relative_path(&self) -> &str {
        match self {
            Self::DuplicateRekey { relative_path, .. }
            | Self::MissingReinsert { relative_path, .. }
            | Self::MisplacedRemove { relative_path, .. } => relative_path,
        }
    }

    pub fn expected_hash(&self) -> &str {
        match self {
            Self::DuplicateRekey { expected_hash, .. }
            | Self::MissingReinsert { expected_hash, .. }
            | Self::MisplacedRemove { expected_hash, .. } => expected_hash,
        }
    }

    pub fn block_id(&self) -> &str {
        match self {
            Self::DuplicateRekey { block_id, .. }
            | Self::MissingReinsert { block_id, .. }
            | Self::MisplacedRemove { block_id, .. } => block_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRepairPreview {
    /// 变更行（0 基）；MissingReinsert = 插入位置
    pub line_index: usize,
    pub before: Option<String>,
    pub after: Option<String>,
    /// DuplicateRekey 生成的新 ID（apply 会复用，保证 preview 与 apply 一致）
    pub new_block_id: Option<String>,
}

/// 计算修复后的文本（不落盘）。返回 (新文本, 预览, eol, add_bom)
fn transform(
    root: &str,
    op: &AnchorRepairOp,
    new_id: Option<&str>,
) -> HostResult<(String, AnchorRepairPreview, String, bool)> {
    let doc = read_document(root, op.relative_path())?;
    if doc.raw_byte_hash != op.expected_hash() {
        return Err(HostError::new(
            super::error::FILE_CONFLICT,
            "文件在预览后有新变化，请刷新后重试",
        )
        .with_path(op.relative_path()));
    }
    if doc.line_ending == "MIXED" {
        return Err(HostError::new(
            PATH_REJECTED,
            "混合换行文件须先规范化才能修复锚点",
        )
        .with_path(op.relative_path()));
    }
    if !valid_uuid(op.block_id()) {
        return Err(HostError::new(
            VERIFY_FAILED,
            "blockId 不是规范 UUID",
        ));
    }
    let anchor = make_anchor_line(op.block_id());
    let lines: Vec<&str> = doc.text.split('\n').collect();

    match op {
        AnchorRepairOp::DuplicateRekey { .. } => {
            let new_id = new_id
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let idx = lines
                .iter()
                .position(|l| l.trim_end_matches('\r') == anchor)
                .ok_or_else(|| {
                    HostError::new(
                        VERIFY_FAILED,
                        "未找到该锚点行（文件已变化？）",
                    )
                    .with_path(op.relative_path())
                })?;
            let mut out = lines.clone();
            let replaced = make_anchor_line(&new_id);
            out[idx] = &replaced;
            let preview = AnchorRepairPreview {
                line_index: idx,
                before: Some(anchor.clone()),
                after: Some(replaced.clone()),
                new_block_id: Some(new_id),
            };
            Ok((out.join("\n"), preview, doc.line_ending, doc.has_bom))
        }
        AnchorRepairOp::MissingReinsert { line_index, .. } => {
            if *line_index > lines.len() {
                return Err(HostError::new(
                    VERIFY_FAILED,
                    format!("行号越界：{line_index} > {}", lines.len()),
                ));
            }
            // §9.2 锚区：合法锚位在标题行与首行正文之间（只允许空白）。
            // 插在 line_index（=该块标题行）下方；若插在上方会落入上一节版图，
            // 重扫即判 MISPLACED（验收 3 实测修正）
            let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
            let mut inserted = false;
            for (i, l) in lines.iter().enumerate() {
                out.push((*l).to_string());
                if i == *line_index {
                    out.push(anchor.clone());
                    inserted = true;
                }
            }
            if !inserted {
                // line_index == lines.len()（文件末尾追加）或空文件
                out.push(anchor.clone());
            }
            let preview = AnchorRepairPreview {
                line_index: (*line_index + 1).min(lines.len()),
                before: None,
                after: Some(anchor.clone()),
                new_block_id: None,
            };
            Ok((out.join("\n"), preview, doc.line_ending, doc.has_bom))
        }
        AnchorRepairOp::MisplacedRemove { .. } => {
            let idx = lines
                .iter()
                .position(|l| l.trim_end_matches('\r') == anchor)
                .ok_or_else(|| {
                    HostError::new(VERIFY_FAILED, "未找到该锚点行（文件已变化？）")
                        .with_path(op.relative_path())
                })?;
            let mut out = lines.clone();
            out.remove(idx);
            let preview = AnchorRepairPreview {
                line_index: idx,
                before: Some(anchor.clone()),
                after: None,
                new_block_id: None,
            };
            Ok((out.join("\n"), preview, doc.line_ending, doc.has_bom))
        }
    }
}

pub fn anchor_repair_preview(root: &str, op: &AnchorRepairOp) -> HostResult<AnchorRepairPreview> {
    let (_, preview, _, _) = transform(root, op, None)?;
    Ok(preview)
}

/// 应用修复：preview 的 new_block_id 优先复用（preview→apply 一致），否则新生成
pub fn anchor_repair_apply(
    root: &str,
    op: &AnchorRepairOp,
    confirmed_new_id: Option<&str>,
) -> HostResult<SaveDocumentResult> {
    if let Some(id) = confirmed_new_id {
        if !valid_uuid(id) {
            return Err(HostError::new(VERIFY_FAILED, "确认的新 ID 不是规范 UUID"));
        }
    }
    let (text, _preview, eol, add_bom) = transform(root, op, confirmed_new_id)?;
    save_document(
        root,
        op.relative_path(),
        SaveDocumentParams {
            text,
            eol,
            add_bom,
            expected_hash: op.expected_hash().to_string(),
        },
    )
}
