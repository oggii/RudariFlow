//! Resume check for model downloads: fetch the first 5 MB of a file as an
//! interrupted download would leave them, then let the downloader finish it.
//!
//!   cargo run --release --example download_probe -- <url> <dest file>
//!
//! Compare the result with the server's SHA-256 afterwards.

use std::path::PathBuf;

use reqwest::header::{ETAG, RANGE};
use rudariflow_lib::downloader::{download_file, part_path};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: download_probe <url> <dest file>");
        std::process::exit(2);
    }
    let (url, dest) = (&args[1], PathBuf::from(&args[2]));
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let _ = std::fs::remove_file(&dest);

    // What an interrupted download leaves behind: the first 5 MB and the ETag.
    let part = part_path(&dest);
    let (bytes, etag) = runtime.block_on(async {
        let response = reqwest::Client::new()
            .get(url)
            .header(RANGE, "bytes=0-5242879")
            .send()
            .await
            .expect("first request");
        let etag = response.headers().get(ETAG).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        (response.bytes().await.expect("first bytes"), etag)
    });
    std::fs::write(&part, &bytes).expect("write part");
    let mut tag = part.clone().into_os_string();
    tag.push(".etag");
    std::fs::write(PathBuf::from(tag), &etag).expect("write etag");
    println!("part: {} bytes, etag {}", bytes.len(), etag);

    let mut first = None;
    let result = runtime.block_on(download_file(url, &dest, |p| {
        if first.is_none() {
            first = Some((p.downloaded, p.total));
        }
    }));
    println!("result: {:?}; first progress (downloaded, total): {:?}", result, first);
    println!("size: {} bytes", std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0));
}
