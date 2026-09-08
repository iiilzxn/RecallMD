// Workspace / 目录树 / 文件管理 / 回收站的 IPC 客户端（设计 §6.2/§13.6，M2）。

import { ipcCall } from "../editor/ipc";

export interface WorkspaceInfoDto {
  workspaceId: string;
  formatVersion: number;
  root: string;
}

export interface RecentEntryDto {
  root: string;
  workspaceId: string | null;
  name: string;
  lastOpenedAtMs: number;
}

export interface TreeEntryDto {
  name: string;
  relativePath: string;
  isDir: boolean;
}

export interface MovePreviewDto {
  kind: "FILE" | "DIR";
  fileCount: number;
  dirCount: number;
  caseOnly: boolean;
}

export interface MoveResultDto {
  operationId: string;
  kind: "FILE" | "DIR";
  fileCount: number;
  dirCount: number;
}

export interface DeletePreviewDto {
  kind: "FILE" | "DIR";
  fileCount: number;
  dirCount: number;
  entries: string[];
  totalEntries: number;
}

export interface DeleteResultDto {
  operationId: string;
}

export interface TrashEntryDto {
  operationId: string;
  kind: "FILE" | "DIR";
  originalRelativePath: string;
  deletedAtMs: number;
  fileCount: number;
  dirCount: number;
}

export interface RestoreResultDto {
  restoredPath: string;
}

export const workspaceIpc = {
  open: (root: string) => ipcCall<WorkspaceInfoDto>("workspace_open", { root }),
  close: () => ipcCall<void>("workspace_close", {}),
  info: () => ipcCall<WorkspaceInfoDto | null>("workspace_info", {}),
  recentList: () => ipcCall<RecentEntryDto[]>("workspace_recent_list", {}),
  recentForget: (root: string) => ipcCall<RecentEntryDto[]>("workspace_recent_forget", { root }),

  treeList: (dir: string) => ipcCall<TreeEntryDto[]>("tree_list", { dir }),
  treeFilter: (query: string, limit?: number) =>
    ipcCall<string[]>("tree_filter", { query, limit }),

  fileCreate: (path: string) => ipcCall<void>("file_create", { path }),
  dirCreate: (path: string) => ipcCall<void>("dir_create", { path }),

  movePreview: (src: string, dst: string) => ipcCall<MovePreviewDto>("fs_move_preview", { src, dst }),
  move: (src: string, dst: string) => ipcCall<MoveResultDto>("fs_move", { src, dst }),

  deletePreview: (path: string) => ipcCall<DeletePreviewDto>("fs_delete_preview", { path }),
  delete: (path: string) => ipcCall<DeleteResultDto>("fs_delete", { path }),

  trashList: () => ipcCall<TrashEntryDto[]>("trash_list", {}),
  trashRestore: (trashId: string, targetPath?: string) =>
    ipcCall<RestoreResultDto>("trash_restore", { trashId, targetPath }),
};
