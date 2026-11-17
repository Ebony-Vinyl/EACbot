// Radix's switch and slider, styled to this app's tokens. Both keep the keyboard and screen-reader behaviour
// a hand-rolled input would lose.
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";

import { cn } from "@/lib/cn";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-accent data-[state=unchecked]:bg-control",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[18px] translate-x-[3px] rounded-full bg-white transition-transform data-[state=checked]:translate-x-[23px]" />
    </SwitchPrimitive.Root>
  );
}

export function Slider({ className, ...props }: ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root className={cn("relative flex h-4 w-full touch-none select-none items-center", className)} {...props}>
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-raised">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-3.5 cursor-pointer rounded-full border-2 border-accent bg-app transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed" />
    </SliderPrimitive.Root>
  );
}
