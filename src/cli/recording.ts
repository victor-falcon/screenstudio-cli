// Screen Studio 3.7 stores video paths per recording session. The media may be
// a display, window, external device, or imported video, with any channel number.
// Offline frame extraction currently reads one continuous media file; refuse to
// silently substitute the first session of a paused/resumed recording.
export const RECORDING_VIDEO = `
  var sessions = p.recording.sessions;
  if (!Array.isArray(sessions) || sessions.length !== 1) {
    throw new Error('Offline frame extraction requires one recording session. Use screenstudio preview for paused/resumed recordings.');
  }
  var videoPath = sessions[0].recordingVideoPath;
  if (typeof videoPath !== 'string' || !videoPath) throw new Error('Screen Studio did not expose the recording video path.');
`;
