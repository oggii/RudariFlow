//! Whisper does one job at a time. When several wait, this gate lets a
//! dictation go first, then a meeting piece, then a block of a file in the
//! Files tab. Nothing is interrupted: a dictation waits for the piece or
//! block that is running, and no longer.

use std::sync::{Condvar, Mutex};

use crate::audio::lock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    Dictation = 0,
    Meeting = 1,
    File = 2,
}

#[derive(Default)]
struct Waiting {
    busy: bool,
    /// Callers waiting, by priority.
    count: [usize; 3],
}

#[derive(Default)]
pub struct Gate {
    state: Mutex<Waiting>,
    turn: Condvar,
}

/// Whisper is yours until this is dropped.
pub struct Pass<'a> {
    gate: &'a Gate,
}

impl Gate {
    pub fn new() -> Gate {
        Gate::default()
    }

    /// Wait until Whisper is free and nobody of a higher priority waits.
    pub fn enter(&self, priority: Priority) -> Pass<'_> {
        let p = priority as usize;
        let mut state = lock(&self.state);
        state.count[p] += 1;
        while state.busy || state.count[..p].iter().any(|&n| n > 0) {
            state = self.turn.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.count[p] -= 1;
        state.busy = true;
        Pass { gate: self }
    }

    /// How many wait now (for tests).
    pub fn waiting(&self) -> usize {
        lock(&self.state).count.iter().sum()
    }
}

impl Drop for Pass<'_> {
    fn drop(&mut self) {
        lock(&self.gate.state).busy = false;
        self.gate.turn.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Start a thread that enters with `priority` and notes when it got in;
    /// return once it waits.
    fn queue(gate: &Arc<Gate>, order: &Arc<Mutex<Vec<Priority>>>, priority: Priority) -> std::thread::JoinHandle<()> {
        let before = gate.waiting();
        let (g, o) = (gate.clone(), order.clone());
        let handle = std::thread::spawn(move || {
            let _pass = g.enter(priority);
            o.lock().unwrap().push(priority);
        });
        while gate.waiting() == before {
            std::thread::yield_now();
        }
        handle
    }

    #[test]
    fn a_dictation_goes_first_then_a_meeting_then_a_file() {
        let gate = Arc::new(Gate::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        // A file block is running; a file, a meeting and a dictation arrive.
        let running = gate.enter(Priority::File);
        let handles = [
            queue(&gate, &order, Priority::File),
            queue(&gate, &order, Priority::Meeting),
            queue(&gate, &order, Priority::Dictation),
        ];
        assert!(order.lock().unwrap().is_empty(), "nobody passes the running block");
        drop(running);
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), [Priority::Dictation, Priority::Meeting, Priority::File]);
    }

    #[test]
    fn a_dictation_waits_only_for_the_piece_that_runs() {
        let gate = Arc::new(Gate::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let piece = gate.enter(Priority::Meeting);
        let next_piece = queue(&gate, &order, Priority::Meeting);
        let dictation = queue(&gate, &order, Priority::Dictation);
        drop(piece);
        dictation.join().unwrap();
        next_piece.join().unwrap();
        assert_eq!(*order.lock().unwrap(), [Priority::Dictation, Priority::Meeting]);
        // A free gate lets anyone in at once.
        drop(gate.enter(Priority::File));
        assert_eq!(gate.waiting(), 0);
    }
}
