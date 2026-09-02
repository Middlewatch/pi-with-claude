# Golden wire frames

`tests/fake_claude.py` replays these. A frame is edited only against a
fresh capture from a real CLI, with the version noted here.

- Base set: characterized 2026-08-09 against `claude` 2.1.226.
- `tool-call-turn-serial.jsonl` and `tool-call-turn-double-thinking.jsonl`:
  characterized 2026-09-02 against `claude` 2.1.258 (serial dispatch of
  hosted calls, and fable 5.1's paired thinking blocks).
- `unknown-event.jsonl`: synthetic, the I4 tolerance drill (an unheard-of
  event type plus JSON scalar lines that are not frames).
