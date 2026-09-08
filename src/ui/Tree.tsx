// M2 侧栏目录树与目录选择树（设计 §16 左侧面板 / §15.2 展开加载）。

import { useEffect, useState, type ReactElement } from "react";
import { workspaceIpc, type TreeEntryDto } from "../workspace/ipc";

export interface TreeRowActions {
  onToggleDir: (rel: string) => void;
  onSelectDir: (rel: string) => void;
  onOpenFile: (rel: string) => void;
  onEntryAction: (entry: TreeEntryDto, action: "rename" | "move" | "delete") => void;
}

function TreeRow({
  entry,
  depth,
  expanded,
  activeRel,
  selectedDir,
  childrenMap,
  actions,
}: {
  entry: TreeEntryDto;
  depth: number;
  expanded: Set<string>;
  activeRel: string | null;
  selectedDir: string;
  childrenMap: Record<string, TreeEntryDto[]>;
  actions: TreeRowActions;
}) {
  const isOpen = expanded.has(entry.relativePath);
  const isActive = activeRel === entry.relativePath;
  const isSelDir = entry.isDir && selectedDir === entry.relativePath;
  return (
    <>
      <div
        className={`tree-row${isActive ? " active" : ""}${isSelDir ? " sel-dir" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() =>
          entry.isDir
            ? (actions.onSelectDir(entry.relativePath), actions.onToggleDir(entry.relativePath))
            : actions.onOpenFile(entry.relativePath)
        }
        title={entry.relativePath}
      >
        {entry.isDir ? (
          <>
            <span className={`tree-caret${isOpen ? " open" : ""}`}>▸</span>
            <span className="tree-icon">📁</span>
          </>
        ) : (
          <span className="tree-icon file">📄</span>
        )}
        <span className="tree-name">{entry.name}</span>
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="tree-act"
            title="重命名"
            onClick={() => actions.onEntryAction(entry, "rename")}
          >
            ✎
          </button>
          <button
            className="tree-act"
            title="移动"
            onClick={() => actions.onEntryAction(entry, "move")}
          >
            ➜
          </button>
          <button
            className="tree-act danger"
            title="删除（移入回收站）"
            onClick={() => actions.onEntryAction(entry, "delete")}
          >
            ✕
          </button>
        </span>
      </div>
      {entry.isDir &&
        isOpen &&
        (childrenMap[entry.relativePath] ?? []).map((c) => (
          <TreeRow
            key={c.relativePath}
            entry={c}
            depth={depth + 1}
            expanded={expanded}
            activeRel={activeRel}
            selectedDir={selectedDir}
            childrenMap={childrenMap}
            actions={actions}
          />
        ))}
    </>
  );
}

/** 主侧栏树：数据与展开状态由 M2App 持有 */
export function SidebarTree({
  childrenMap,
  expanded,
  activeRel,
  selectedDir,
  actions,
}: {
  childrenMap: Record<string, TreeEntryDto[]>;
  expanded: Set<string>;
  activeRel: string | null;
  selectedDir: string;
  actions: TreeRowActions;
}) {
  const root = childrenMap[""];
  if (!root) {
    return <div className="tree-loading">载入中…</div>;
  }
  return (
    <div className="tree">
      {root.map((e) => (
        <TreeRow
          key={e.relativePath}
          entry={e}
          depth={0}
          expanded={expanded}
          activeRel={activeRel}
          selectedDir={selectedDir}
          childrenMap={childrenMap}
          actions={actions}
        />
      ))}
    </div>
  );
}

/** 移动对话框内的目录选择树：仅目录、自带局部展开状态 */
export function DirPickerTree({
  excludeSubtreeOf,
  selected,
  onSelect,
}: {
  /** 禁止选入自身子树（不能移动到目录内部） */
  excludeSubtreeOf: string | null;
  selected: string;
  onSelect: (rel: string) => void;
}) {
  const [childrenMap, setChildrenMap] = useState<Record<string, TreeEntryDto[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    workspaceIpc
      .treeList("")
      .then((entries) => {
        if (alive) setChildrenMap((m) => ({ ...m, "": entries }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const loadDir = (rel: string) => {
    workspaceIpc
      .treeList(rel)
      .then((entries) => setChildrenMap((m) => ({ ...m, [rel]: entries })))
      .catch(() => {});
  };

  const disabled = (rel: string) =>
    excludeSubtreeOf != null &&
    (rel === excludeSubtreeOf ||
      (rel.length > excludeSubtreeOf.length &&
        rel.toLowerCase().startsWith(excludeSubtreeOf.toLowerCase() + "/")));

  const renderDir = (rel: string, name: string, depth: number): ReactElement[] => {
    const isOpen = expanded.has(rel);
    const rows: ReactElement[] = [
      <div
        key={rel}
        className={`tree-row picker${selected === rel ? " sel-dir" : ""}${disabled(rel) ? " disabled" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => !disabled(rel) && onSelect(rel)}
        title={rel || "（根目录）"}
      >
        <span
          className={`tree-caret${isOpen ? " open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled(rel)) return;
            setExpanded((s) => {
              const n = new Set(s);
              if (n.has(rel)) n.delete(rel);
              else {
                n.add(rel);
                if (!childrenMap[rel]) loadDir(rel);
              }
              return n;
            });
          }}
        >
          ▸
        </span>
        <span className="tree-icon">📁</span>
        <span className="tree-name">{name}</span>
      </div>,
    ];
    if (isOpen) {
      for (const c of childrenMap[rel] ?? []) {
        if (c.isDir) rows.push(...renderDir(c.relativePath, c.name, depth + 1));
      }
    }
    return rows;
  };

  return <div className="tree dir-picker">{renderDir("", "（根目录）", 0)}</div>;
}
