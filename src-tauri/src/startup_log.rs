use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Open for the app's lifetime (each line used to open and close the file).
static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);

/// At start, a log larger than this moves to startup.prev.log.
const ROTATE_AT_BYTES: u64 = 2 * 1024 * 1024;

pub fn init(app_dir: &PathBuf) {
    let _ = std::fs::create_dir_all(app_dir);
    let path = app_dir.join("startup.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > ROTATE_AT_BYTES) {
        let _ = std::fs::rename(&path, app_dir.join("startup.prev.log"));
    }
    *LOG_FILE.lock().unwrap_or_else(|p| p.into_inner()) = OpenOptions::new().create(true).append(true).open(&path).ok();
    log("=== RudariFlow startup ===");
    log(&format!("version: {}", env!("CARGO_PKG_VERSION")));
    log(&format!(
        "cwd: {:?}",
        std::env::current_dir().unwrap_or_default()
    ));
    log(&format!("args: {:?}", std::env::args().collect::<Vec<_>>()));
    log(&format!(
        "exe: {:?}",
        std::env::current_exe().unwrap_or_default()
    ));
}

pub fn log(msg: &str) {
    let now = chrono_like_now();
    let line = format!("[{}] {}\n", now, msg);
    eprintln!("{}", line.trim_end());
    if let Some(file) = LOG_FILE.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Tiny "now" formatter without pulling in chrono. Format: 2026-04-25 21:35:42.123
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = dur.as_secs();
    let millis = dur.subsec_millis();
    // Convert to UTC date components.
    let (y, mo, d, h, mi, s) = secs_to_ymdhms(total_secs);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, h, mi, s, millis
    )
}

fn secs_to_ymdhms(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let s = (secs % 86_400) as u32;
    let h = s / 3600;
    let mi = (s % 3600) / 60;
    let se = s % 60;
    // Days since 1970-01-01 -> civil date (Howard Hinnant algorithm).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d, h, mi, se)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_large_log_moves_aside_at_start() {
        let dir = std::env::temp_dir().join("rudariflow_log_rotate");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("startup.log"), vec![b'x'; ROTATE_AT_BYTES as usize + 1]).unwrap();
        init(&dir);
        log("after rotation");
        let prev = std::fs::metadata(dir.join("startup.prev.log")).unwrap().len();
        assert_eq!(prev, ROTATE_AT_BYTES + 1);
        let current = std::fs::read_to_string(dir.join("startup.log")).unwrap();
        assert!(current.contains("=== RudariFlow startup ===") && current.contains("after rotation"));
    }
}
