/**
 * Project status (stored as the legacy `rag_status` enum) shown with
 * descriptive labels + vibrant semantic pill colours.
 */
export type RagStatus = "not_started" | "red" | "amber" | "green" | "complete";
export type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

export function ragLabel(rag: RagStatus | string): string {
  switch (rag) {
    case "green":
      return "On track";
    case "amber":
      return "At risk";
    case "red":
      return "Delayed";
    case "complete":
      return "Complete";
    case "not_started":
    default:
      return "In progress";
  }
}

export function ragTone(rag: RagStatus | string): Tone {
  switch (rag) {
    case "green":
      return "success"; // On track → green
    case "complete":
      return "success"; // Complete → green
    case "amber":
      return "warning"; // At risk → amber
    case "red":
      return "danger"; // Delayed → red
    case "not_started":
    default:
      return "info"; // In progress → blue
  }
}
