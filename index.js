const { spawn } = require("child_process");
const http = require('http');
const fs = require('fs');
const path = require('path');
var qs = require('querystring');
var port = process.argv[2] || 8888;

function list(url) {
    //const ls = spawn("ls", ["-la", "ffmpeg/"]);
    //"https://www.youtube.com/playlist?list=PLgcoT7-W0fP2Bqm6KqWPIaTvF4_WLfv3b"
    const yt_list = spawn("yt-dlp", ["--flat-playlist", "--print",
        '%(title)s | %(id)s | %(webpage_url)s',
        url])

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
}

var server = http.createServer((req, res) => {
    let saved = '';
    let filename = '';
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.write(fs.readFileSync(__dirname + '/index.html'));
        res.end();
    } else if (req.url === '/list' && req.method === 'POST') {
        var body = '';

        req.on('data', function (data) {
            body += data;

            // Too much POST data, kill the connection!
            // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
            if (body.length > 1e6)
                request.connection.destroy();
        });

        req.on('end', function () {
            var post = qs.parse(body);
            console.log(post);
        });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    }
    else {
        console.log(res.url);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404');
    }
});

server.listen(port, () => {
    console.log('Server listening on http://localhost:' + port);
});