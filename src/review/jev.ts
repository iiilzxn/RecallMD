import { ipcCall } from "../editor/ipc";
import type { ReviewBeginResultDto } from "./ipc";

export interface JevConfig { enabled: boolean; hasApiKey: boolean }
export interface ReviewRubric { points: string[] }
export interface NoteRubric { blockId: string; headingOffset: number; points: string[] }
export interface SaveNoteRubric {
  relativePath: string;
  expectedHash: string;
  blockId: string;
  expectedPoints: string[];
  points: string[];
}
export interface JevPointScore {
  point: string;
  /** 三档 Score 的原始值，范围 0–2。 */
  score: number;
  confidence: number;
  probabilities: [number, number, number];
}
export interface JevGrade { score: number; points: JevPointScore[]; preview?: boolean }

export const jevIpc = {
  config: () => ipcCall<JevConfig>("jev_config_read", {}),
  saveConfig: (enabled: boolean, apiKey: string | null = null) =>
    ipcCall<JevConfig>("jev_config_save", { enabled, apiKey }),
  clearKey: () => ipcCall<JevConfig>("jev_key_clear", {}),
  rubric: (blockId: string) => ipcCall<ReviewRubric>("review_rubric_read", { blockId }),
  saveRubric: (token: string, points: string[]) => ipcCall<ReviewBeginResultDto>("review_rubric_save", { token, points }),
  noteRubrics: (relativePath: string, expectedHash: string) => ipcCall<NoteRubric[]>("note_rubrics_read", { relativePath, expectedHash }),
  saveNoteRubric: (request: SaveNoteRubric) => ipcCall<NoteRubric>("note_rubric_save", { request }),
  grade: (token: string, answer: string) => ipcCall<JevGrade>("jev_grade", { token, answer }),
};

export function parseRubricDraft(draft: string): string[] {
  return draft.split(/\r?\n/).map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, "").trim()).filter(Boolean);
}

export function rubricProblem(points: string[]): string | null {
  if (points.length > 30) return "每题最多 30 个得分点，请合并相近的内容。";
  if (points.some((point) => [...point].length > 500)) return "每个得分点最多 500 字，请简化后保存。";
  return null;
}

export const JEV_CONFIDENCE_THRESHOLD = 0.6;

export function pointVerdict(point: JevPointScore): string {
  if (point.confidence < JEV_CONFIDENCE_THRESHOLD) return "需自行核对";
  const level = point.probabilities.indexOf(Math.max(...point.probabilities));
  return ["未覆盖或有误", "部分覆盖", "完整覆盖"][level];
}

/** 按可见字符截断，保留 emoji/组合字符；完整字符串仍用于保存和评分。 */
export function pointLabel(point: string): string {
  const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
  const chars = Array.from(segmenter.segment(point), (part) => part.segment);
  return chars.length > 5 ? `${chars.slice(0, 5).join("")}…` : point;
}
