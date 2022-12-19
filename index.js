const { spawn } = require("child_process");
const http = require('http');
const fs = require('fs');
const path = require('path');
var qs = require('querystring');
var port = process.argv[2] || 8888;

var server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.write(fs.readFileSync(__dirname + '/index.html'));
        res.end();
    }
    else if (req.url === '/list' && req.method === 'POST') {
        var body = '', body_url = '', response = '';
        req.on('data', function (data) {
            body += data;
            // Too much POST data, kill the connection!
            // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
            if (body.length > 1e6)
                request.connection.destroy();
        });
        req.on('end', function () {
            body_url = qs.parse(body);
            console.log("url: ", body_url['url_input']);
            const yt_list = spawn("yt-dlp", ["--flat-playlist", "--print",
                '%(title)s | %(id)s | %(webpage_url)s', body_url['url_input']]);
            yt_list.stdout.on("data", data => {
                response += data;
                //return (`stdout: ${data}`);
            });
            yt_list.stderr.on("data", data => {
                response = `stderr: ${data}`;
                //return (`stderr: ${data}`);
            });
            yt_list.on('error', (error) => {
                response = `error: ${error.message}`;
                //return (`error: ${error.message}`);
            });
            yt_list.on("close", code => {
                response += `child process exited with code ${code}`;
                //console.log(`child process exited with code ${code}`);
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(response);
            });
        });
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