/** Defines remote pointer and keyboard messages; depends on Zod; does not authenticate, confirm or perform native input. */
import { z } from 'zod';

export const MAX_INPUT_EVENTS = 32;
export const MAX_POINTER_STEP = 2_000;
export const MAX_TEXT_CHARS = 64;
export const KEYS = ['enter', 'backspace', 'delete', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'volumeup', 'volumedown', 'mute', 'playpause', 'next', 'previous',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;
export const MODIFIERS = ['shift', 'ctrl', 'alt', 'meta'] as const;
const step = z.number().int().min(-MAX_POINTER_STEP).max(MAX_POINTER_STEP);
export const inputEventSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('move'), dx: step, dy: step }),
  z.strictObject({ t: z.literal('button'), button: z.enum(['left', 'right', 'middle']), action: z.enum(['down', 'up', 'click']) }),
  z.strictObject({ t: z.literal('scroll'), dx: step, dy: step }),
  // tap (default) is a full press; down/up hold or release the chord so pointers like PowerPoint's Ctrl+drag laser can exist.
  z.strictObject({ t: z.literal('key'), key: z.enum(KEYS), modifiers: z.array(z.enum(MODIFIERS)).max(4).optional(),
    action: z.enum(['tap', 'down', 'up']).optional() }),
  // Printable text only: no control characters, no lone surrogates.
  z.strictObject({ t: z.literal('text'), text: z.string().min(1).max(MAX_TEXT_CHARS).refine(s => !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(s)) }),
]);
export type InputEvent = z.infer<typeof inputEventSchema>;
export const sessionRef = z.strictObject({ controlSessionId: z.string().uuid() });
export const sendSchema = z.strictObject({ controlSessionId: z.string().uuid(), sequence: z.number().int().min(1),
  events: z.array(inputEventSchema).min(1).max(MAX_INPUT_EVENTS) });
export const beginSchema = z.strictObject({});

/** Keyboard macros: named saved key chords (e.g. "Paste plain" = ctrl+shift+v), stored on the desktop, run by the phone through a normal control session. */
export const MAX_MACROS = 24;
export const MAX_MACRO_STEPS = 8;
export const macroNameSchema = z.string().min(1).max(40).refine(value => !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value));
export const macroStepSchema = z.strictObject({ key: z.enum(KEYS), modifiers: z.array(z.enum(MODIFIERS)).max(4).optional() });
export const keyboardMacroSchema = z.strictObject({ id: z.string().uuid(), name: macroNameSchema,
  steps: z.array(macroStepSchema).min(1).max(MAX_MACRO_STEPS) });
export const saveMacroSchema = z.strictObject({ id: z.string().uuid().optional(), name: macroNameSchema,
  steps: z.array(macroStepSchema).min(1).max(MAX_MACRO_STEPS) });
export const macroIdPayloadSchema = z.strictObject({ id: z.string().uuid() });
export const keyboardMacrosSchema = z.strictObject({ macros: z.array(keyboardMacroSchema).max(MAX_MACROS) });
export type KeyboardMacro = z.infer<typeof keyboardMacroSchema>;
