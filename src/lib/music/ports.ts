// The music module's single door to the host app. Every file under
// components/music and lib/music imports host capabilities from here and nothing
// else, so the planned frontend refactor re-points this one file instead of the
// whole module. The ui re-exports are the app's shadcn layer; when the music
// module grows its own primitives, swap them here.
export { t } from "@/lib/i18n";
export { cn } from "@/lib/cn";
export { speaker, type SpeechSnapshot } from "@/lib/tts";
export { api } from "@/state/api";
export { listenLiveFrames } from "@/lib/live-events";
export { Button } from "@/components/ui/button";
export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
export { Chip, ChipRow, EmptyState, Field, Input, Notice, SearchInput } from "@/components/ui/field";
export { Slider, Switch } from "@/components/ui/switch-slider";
