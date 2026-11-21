// Speech and music share one speaker. The renderer is where both actually sound, so
// it is where the claim is made: while the Speaker is talking, music is ducked, and
// when it stops the server decides whether music may come back (a person's own pause
// outranks a lease).
import { speaker, type SpeechSnapshot } from "@/lib/music/ports";

interface Lease {
  leaseId: string;
}

let lease: Lease | null = null;
let watching = false;

async function claim(holder: string): Promise<void> {
  if (lease) return;
  try {
    const answer = await fetch("/api/music/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", holder }),
    }).then((response) => response.json() as Promise<{ lease?: { leaseId: string } }>);
    if (answer.lease) lease = answer.lease;
  } catch {
    // No music service is not a reason to stop speaking.
  }
}

async function release(): Promise<void> {
  const held = lease;
  lease = null;
  if (!held) return;
  try {
    await fetch("/api/music/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release", leaseId: held.leaseId }),
    });
  } catch {
    // A lease that outlives its release expires on its own; music then resumes.
  }
}

/** Starts watching the Speaker. Idempotent, so every mount may call it. */
export function installSpeechFocus(): void {
  if (watching) return;
  watching = true;
  speaker.subscribe((snapshot: SpeechSnapshot) => {
    const speaking = snapshot.status !== "idle";
    if (speaking) void claim(snapshot.messageId ? `speech:${snapshot.messageId}` : "speech");
    else void release();
  });
}
