const { spawn } = require("child_process");

//const ls = spawn("ls", ["-la", "ffmpeg/"]);
const yt_list = spawn("yt-dlp", ["--flat-playlist", "--print",
    '%(title)s | %(id)s | %(webpage_url)s',
    "https://www.youtube.com/playlist?list=PLgcoT7-W0fP2Bqm6KqWPIaTvF4_WLfv3b"])

yt_list.stdout.on("data", data => {
    console.log(`stdout: ${data}`);
});

yt_list.stderr.on("data", data => {
    console.log(`stderr: ${data}`);
});

yt_list.on('error', (error) => {
    console.log(`error: ${error.message}`);
});

yt_list.on("close", code => {
    console.log(`child process exited with code ${code}`);
});