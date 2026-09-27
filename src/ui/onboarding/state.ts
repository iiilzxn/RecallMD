/** Device-local guidance preferences; never stored in a note or a review record. */
export const ONBOARDING_KEY = "recallmd.onboarding.v1";
export const TOUR_STEPS = ["workspace", "note", "include", "preview", "points", "learn", "reveal", "rate", "done"] as const;
export type TourStep = typeof TOUR_STEPS[number];
export interface GuideState {
  version: 1;
  introSeen: boolean;
  status: "idle" | "active" | "paused" | "complete";
  step: TourStep;
}
export const INITIAL_GUIDE: GuideState = { version: 1, introSeen: false, status: "idle", step: "workspace" };

export interface GuideReviewState {
  phase: "loading" | "hidden" | "revealed" | "done";
}
export interface GuideContext {
  workspace: boolean;
  file: boolean;
  view: "editor" | "review" | "settings" | "stats";
  clean: boolean;
  enrolled: boolean;
  preview: boolean;
  empty: boolean;
  canEdit: boolean;
  engineDead: boolean;
  oversized: boolean;
  review: GuideReviewState | null;
}

export function readGuide(): GuideState {
  try {
    const value = JSON.parse(localStorage.getItem(ONBOARDING_KEY) ?? "null") as GuideState | null;
    // Older guides paused at the removed goal editor resume at the question.
    if (value && (value.step as string) === "goal") value.step = "reveal";
    if (value?.version === 1 && typeof value.introSeen === "boolean" &&
      ["idle", "active", "paused", "complete"].includes(value.status) && TOUR_STEPS.includes(value.step)) return value;
  } catch { /* An unavailable or malformed preference must not block the app. */ }
  return { ...INITIAL_GUIDE };
}

export function writeGuide(state: GuideState): void {
  try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(state)); } catch { /* Session-only guidance still works. */ }
}

export function nextStep(step: TourStep): TourStep {
  return TOUR_STEPS[Math.min(TOUR_STEPS.indexOf(step) + 1, TOUR_STEPS.length - 1)];
}

/** Advance from observed application state, never from a click that might fail. */
export function observedStep(step: TourStep, context: GuideContext): TourStep {
  if (!context.workspace) return step;
  if (step === "workspace") return "note";
  if (step === "note" && context.file && context.view === "editor") return "include";
  if (step === "include" && context.file && context.clean && context.enrolled) return "preview";
  if (step === "preview" && context.file && context.preview && context.view === "editor" && context.clean && context.enrolled) return "points";
  if (step === "learn" && context.view === "review" && context.review && context.review.phase !== "loading") return "reveal";
  if (context.view === "review") {
    if (step === "reveal" && context.review?.phase === "revealed") return "rate";
  }
  // Saving a rubric and submitting a rating use explicit success callbacks.
  return step;
}

/** A resumed tour may need its workspace/file reopened first. Keep its progress. */
export function visibleStep(step: TourStep, context: GuideContext): TourStep {
  if (step === "done") return step;
  if (!context.workspace) return "workspace";
  if (["include", "preview", "points"].includes(step) && !context.file) return "note";
  if (step === "points" && (!context.clean || !context.enrolled)) return "include";
  if (step === "points" && !context.preview) return "preview";
  if (step === "rate" && context.view === "review" && context.review?.phase === "hidden") return "reveal";
  return step;
}
