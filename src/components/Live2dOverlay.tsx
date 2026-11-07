import { useEffect, useRef } from "react";

import { DEFAULT_CHARACTER, useLive2dEnabled, useLive2dModel } from "@/lib/live2d";
import type { Player } from "@livliv-dev/player";

type MascotCommand =
  | { type: "load"; source: string }
  | { type: "expression"; id: string; weight?: number }
  | { type: "act"; action: string }
  | { type: "params"; set: Record<string, number> }
  | { type: "say"; text?: string; clip?: string }
  | { type: "scale"; value: number };

async function applyCommand(player: Player, command: MascotCommand, speak: (text: string) => void): Promise<void> {
  switch (command.type) {
    case "load":
      await player.load(command.source);
      break;
    case "expression":
      player.setExpression(command.id, command.weight ?? 1);
      break;
    case "act":
      player.act(command.action as never);
      break;
    case "params":
      Object.assign(player.params, command.set);
      break;
    case "say":
      if (command.clip) {
        const { createSpeech } = await import("@livliv-dev/player/voice");
        createSpeech(player).say(command.clip);
      } else if (command.text) {
        speak(command.text);
      }
      break;
    case "scale":
      break; // handled by the caller through the wrapper's style
  }
}

export function Live2dOverlay() {
  const enabled = useLive2dEnabled();
  const model = useLive2dModel();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let teardown = (): void => undefined;

    void (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const { Player: PlayerCtor } = await import("@livliv-dev/player");
        if (cancelled) return;
        const player = new PlayerCtor(canvas);
        try {
          await player.load(model || DEFAULT_CHARACTER);
        } catch {
          try {
            await player.load(DEFAULT_CHARACTER);
          } catch {
            return; // no model could be loaded: the overlay stays empty
          }
        }

        // Text speech: browser TTS drives a simple mouth flap.
        const speak = (text: string): void => {
          try {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.onstart = () => Object.assign(player.params, { mouthOpen: 0.7 });
            utterance.onend = () => Object.assign(player.params, { mouthOpen: 0 });
            utterance.onerror = () => Object.assign(player.params, { mouthOpen: 0 });
            speechSynthesis.speak(utterance);
          } catch {
            // no TTS voice available
          }
        };

        const source = new EventSource("/api/mascot/stream");
        source.onmessage = (event) => {
          try {
            const command = JSON.parse(event.data) as MascotCommand;
            if (command.type === "scale" && wrapRef.current) {
              wrapRef.current.style.zoom = String(command.value);
            }
            void applyCommand(player, command, speak);
          } catch {
            // ignore malformed commands
          }
        };
        teardown = () => {
          source.close();
          try {
            player.dispose();
          } catch {
            // already disposed
          }
        };
      } catch {
        // the player failed to start: the overlay stays empty
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [enabled, model]);

  if (!enabled) return null;
  return (
    <div ref={wrapRef} className="live2d-overlay" aria-hidden={true}>
      <canvas ref={canvasRef} width={360} height={480} />
    </div>
  );
}
