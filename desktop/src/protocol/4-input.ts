/** Defines remote pointer and keyboard messages; depends on Zod; does not authenticate, confirm or perform native input. */
import { z } from 'zod';

export const MAX_INPUT_EVENTS = 32;
export const MAX_POINTER_STEP = 2_000;
export const MAX_TEXT_CHARS = 64;
export const KEYS = ['enter', 'backspace', 'delete', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'volumeup', 'volumedown', 'mute', 'playpause', 'next', 'previous'] as const;
export const MODIFIERS = ['shift', 'ctrl', 'alt', 'meta'] as const;
const step = z.number().int().min(-MAX_POINTER_STEP).max(MAX_POINTER_STEP);
export const inputEventSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('move'), dx: step, dy: step }),
  z.strictObject({ t: z.literal('button'), button: z.enum(['left', 'right', 'middle']), action: z.enum(['down', 'up', 'click']) }),
  z.strictObject({ t: z.literal('scroll'), dx: step, dy: step }),
  z.strictObject({ t: z.literal('key'), key: z.enum(KEYS), modifiers: z.array(z.enum(MODIFIERS)).max(4).optional() }),
  // Printable text only: no control characters, no lone surrogates.
  z.strictObject({ t: z.literal('text'), text: z.string().min(1).max(MAX_TEXT_CHARS).refine(s => !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(s)) }),
]);
export type InputEvent = z.infer<typeof inputEventSchema>;
export const sessionRef = z.strictObject({ controlSessionId: z.string().uuid() });
export const sendSchema = z.strictObject({ controlSessionId: z.string().uuid(), sequence: z.number().int().min(1),
  events: z.array(inputEventSchema).min(1).max(MAX_INPUT_EVENTS) });
export const beginSchema = z.strictObject({});
