/** Short, deterministic lines for event reactions (no AI, no network). */
export type MessageKey = "success" | "failure" | "long" | "welcome";

export const EVENT_MESSAGES: Record<MessageKey, readonly string[]> = {
  success: ["Build complete!", "Build succeeded!", "Nice, that built!", "Smooth build!", "Green across the board!"],
  failure: [
    "That didn't go as planned.", "Build failed. We'll sort it out.", "Hmm, that one broke. You've got this.",
    "Not this time. Let's look closer.", "Errors happen. One step at a time.",
  ],
  long: ["Finally, done!", "That was a long one. Nice!", "All done. Worth the wait!", "Long task complete!"],
  welcome: ["Welcome back!", "There you are!", "Good to see you again!"],
};
