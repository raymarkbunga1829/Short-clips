/**
 * Choices shared by the browser and the server. Kept free of Node imports so
 * the client bundle can use it directly.
 */

export const LIMITS = {
  minSeconds: 10,
  maxSeconds: 30,
  defaultSeconds: 16,
  maxTopicLength: 120,
};

export const LENGTH_CHOICES = [15, 20, 30];

export const DEFAULT_VOICE = "en-US-AriaNeural";

export const VOICES = [
  { id: "en-US-AriaNeural", label: "Aria · US" },
  { id: "en-US-AndrewNeural", label: "Andrew · US" },
  { id: "en-US-EmmaNeural", label: "Emma · US" },
  { id: "en-US-GuyNeural", label: "Guy · US" },
  { id: "en-GB-SoniaNeural", label: "Sonia · UK" },
  { id: "en-AU-NatashaNeural", label: "Natasha · AU" },
];

export const EXAMPLE_TOPICS = [
  "Why small habits compound",
  "How sleep debt actually works",
  "The 2-minute rule for procrastination",
  "Why your phone feels addictive",
];
