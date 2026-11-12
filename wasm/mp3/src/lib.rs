//! A streaming MP3 encoder for scoredit's audio export: rusty_mp3 behind a C ABI.
use rusty_mp3::{Mp3Encoder, Mp3EncoderConfig};

static mut ENC: Option<Mp3Encoder> = None;
static mut INPUT: Vec<f32> = Vec::new();
static mut OUT: Vec<u8> = Vec::new();
static mut CHANNELS: u16 = 2;
static mut RATE: u32 = 44100;

#[allow(static_mut_refs)]
unsafe fn drain() -> usize {
    OUT.clear();
    if let Some(enc) = ENC.as_mut() {
        while let Ok(p) = enc.next_packet() {
            OUT.extend_from_slice(&p);
        }
    }
    OUT.len()
}

/// Starts a stream: channels (1 or 2), sample rate, CBR bitrate in kbps.
#[no_mangle]
pub unsafe extern "C" fn mp3_start(channels: u32, rate: u32, kbps: u32) {
    ENC = Some(Mp3Encoder::new(Mp3EncoderConfig { bitrate_kbps: kbps, vbr_quality: None }));
    CHANNELS = channels as u16;
    RATE = rate;
}

/// Room for n interleaved samples; the caller writes them there, then calls mp3_push.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn mp3_input(n: usize) -> *mut f32 {
    INPUT.resize(n, 0.0);
    INPUT.as_mut_ptr()
}

/// Encodes the n samples in the input; returns the number of bytes ready at mp3_output.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn mp3_push(n: usize) -> usize {
    if let Some(enc) = ENC.as_mut() {
        let n = n.min(INPUT.len());
        if enc.push_pcm_f32(&INPUT[..n], CHANNELS, RATE).is_err() {
            return 0;
        }
    }
    drain()
}

/// Ends the stream; returns the bytes of the last frames. mp3_tag then has the gapless header frame.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn mp3_finish() -> usize {
    if let Some(enc) = ENC.as_mut() {
        enc.finish();
    }
    drain()
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn mp3_output() -> *const u8 {
    OUT.as_ptr()
}

/// The completed Info tag frame (to overwrite the stream's first frame), and its length.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn mp3_tag() -> *const u8 {
    ENC.as_ref().and_then(|e| e.lame_tag_frame()).map_or(std::ptr::null(), |t| t.as_ptr())
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn mp3_tag_len() -> usize {
    ENC.as_ref().and_then(|e| e.lame_tag_frame()).map_or(0, |t| t.len())
}
