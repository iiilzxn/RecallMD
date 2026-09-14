// M5 复习服务运行时单例：M6 Review UI 的落点；M5 验收经
// window.__recallmd.review（M2App 挂桥）驱动真实 TS scheduler ↔ Rust 事务全链路。

import { createSystemClock } from "./clock";
import { reviewIpc } from "./ipc";
import { ReviewService } from "./service";

let shared: ReviewService | null = null;

export function reviewService(): ReviewService {
  if (!shared) {
    shared = new ReviewService({ ipc: reviewIpc, clock: createSystemClock() });
  }
  return shared;
}
