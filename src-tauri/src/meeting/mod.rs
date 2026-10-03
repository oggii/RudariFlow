//! Meeting mode: an online call on this PC recorded as two tracks, the
//! microphone ("You") and what the PC plays ("Others"), transcribed live,
//! with the others told apart and AI notes after Stop. See
//! docs/superpowers/specs/2026-10-03-meeting-mode-design.md.

pub mod capture;
pub mod lines;
pub mod notes;
pub mod playback;
pub mod store;
pub mod wav;
