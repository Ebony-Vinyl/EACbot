// The EAC_* switches the harness gives the agents proxy, read into the profile agents-catalog.ts lists tools for.

/** Which tools a conversation is shown, the same on every one of its turns. Presentation only: the server still
 * authenticates and scopes every call. */
export interface CatalogProfile {
  skillAuthoring: boolean;
  sharedComputers: boolean;
  voiceNotes: boolean;
  /** A treg key or a Cloud plan's research credential is held and this bot's research switch is on: x_search is mounted.
   * Absent means off. */
  xResearch?: boolean;
  /** As xResearch, and research works for that credential (the person's treg key, or a plan whose relay has research
   * on): research_search, research_endpoint and research_call are mounted too. Absent means off. */
  research?: boolean;
  cloudHome: boolean;
  memoryEnabled?: boolean;
  /** The section's Chief of Staff; the server refuses Chief-only tools to every other bot. */
  chief: boolean;
  /** Only for Watcher's own tool. Never written into a schema: a list that names its bot can't share a prompt cache with other bots. */
  botId: string;
  /** features.chiefEscalations: raise_escalation is mounted. */
  escalations?: boolean;
  /** A Team Cloud: message_person is mounted. */
  team?: boolean;
  /** The person's EACbot with a Chief's powers: its notification tools are mounted. */
  mausbot?: boolean;
  /** A direct chat whose bot may pick where it works (Works on is not Off and no team computer is its own): select_computer
   * is mounted, and the harness refuses a pick on any turn but a person's own message. */
  computerSelection?: boolean;
  /** A room's thread: the wait tools are not mounted, since a room holds no wait. */
  room?: boolean;
  imageGeneration?: boolean;
}

/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env: NodeJS.ProcessEnv): CatalogProfile {
  return {
    skillAuthoring: env.EAC_SKILL_AUTHORING_ENABLED === "1",
    sharedComputers: env.EAC_SHARED_COMPUTERS_ENABLED === "1",
    voiceNotes: env.EAC_VOICE_NOTES === "1",
    xResearch: env.EAC_X_RESEARCH === "1",
    research: env.EAC_RESEARCH === "1",
    cloudHome: env.EAC_CLOUD_HOME === "1",
    memoryEnabled: env.EAC_MEMORY_ENABLED !== "0",
    chief: env.EAC_CHIEF_OF_STAFF === "1",
    botId: env.EAC_BOT_ID ?? "",
    escalations: env.EAC_ESCALATIONS === "1",
    team: env.EAC_TEAM_PEOPLE === "1",
    mausbot: env.EAC_MAUSBOT === "1",
    computerSelection: env.EAC_COMPUTER_SELECTION === "1",
    room: env.EAC_ROOM === "1",
    imageGeneration: env.EAC_IMAGE_GENERATION === "1",
  };
}
