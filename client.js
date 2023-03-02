function sockSetup() {
    //console.log("Sock setup started");
    var socket = io({ path: "/ytdiff/socket.io/" });
    var myToastEl = document.getElementById('notify'),
        list_btn = document.getElementById("listit"),
        dnld_btn = document.getElementById("dnld");
    socket.on('init', function (data) {
        //console.log(data.message);
        // Respond with a message including this clients' id sent from the server
        socket.emit('acknowledge', { data: 'Connected', id: data.id });
    });
    socket.on('download-start', function (data) {
        //console.groupCollapsed(`Downloading: ${data.message}`);
    });
    socket.on('progress', function (data) {
        if (list_btn.disabled != true && dnld_btn.disabled != true) {
            list_btn.disabled = true;
            dnld_btn.disabled = true;
        }
        //console.log(data.message);
    });
    socket.on('error', console.error.bind(console));
    socket.on('download', function (data) {
        //console.log(`Downloaded: ${data.message} ✅`);
        //console.groupEnd();
        // Re-enable the buttons
        list_btn.disabled = false;
        dnld_btn.disabled = false;
        myToastEl.children[0].children[0].innerHTML = `${data.message} ✅`;
        var myToast = new bootstrap.Toast(myToastEl, {
            delay: 5000
        }); // Returns a Bootstrap toast instance
        myToast.show();
    });
    socket.on('playlist', function (data) {
        //console.log(`Playlist: ${data.message} ✅`);
        //console.groupEnd();
        // Re-enable the buttons
        list_btn.disabled = false;
        dnld_btn.disabled = false;
        myToastEl.children[0].children[0].innerHTML = `${data.message} ✅`;
        var myToast = new bootstrap.Toast(myToastEl, {
            delay: 5000
        }); // Returns a Bootstrap toast instance
        myToast.show();
    });
};

function list_it() {
    try {
        var url = new URL(document.getElementById("url").value);
        if (url.protocol == "https:" || url.protocol == "http:") {
            url = url.href;
        } else {
            throw new Error("Not a valid URL");
        }
        document.getElementById("listit").disabled = true;
        document.getElementById("dnld").disabled = true;
        // var url_list = document.getElementById("url_list").value.split("\n");
        if (document.getElementById("start").value === "") {
            document.getElementById("start").value = 0;
        }
        if (document.getElementById("stop").value === "") {
            document.getElementById("stop").value = 10;
        }
        var start = document.getElementById("start").value;
        if (start == "0") {
            start = 1; // yt-dlp doesn't start counting form 0 but sequelize does
        }
        var stop = document.getElementById("stop").value;
        var chunk = document.getElementById("chunk").value;
        const table = document.getElementById("listing");
        //console.log("URL: " + url, "Start: " + start, "Stop: " + stop, "Chunk size: " + chunk);
        if (url != '') {
            fetch("/ytdiff/list", {
                method: "post",
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                //make sure to serialize your JSON body
                body: JSON.stringify({
                    url: url,
                    start: start,
                    stop: stop,
                    chunk: chunk
                })
            }).then((response) => response.text()).then((text) => makeSubTable(text));
        }
    } catch (err) {
        var myToastEl = document.getElementById('notify');
        //console.error(err);
        myToastEl.children[0].children[0].innerHTML = `Not a valid URL ❌`;
        var myToast = new bootstrap.Toast(myToastEl, {
            delay: 5000
        }); // Returns a Bootstrap toast instance
        myToast.show();
    }
};

function select_all() {
    document.querySelectorAll('input[type=checkbox].video-item').forEach(element => {
        element.checked = true;
    });
};
function select_none() {
    document.querySelectorAll('input[type=checkbox].video-item').forEach(element => {
        element.checked = false;
    });
};

function download_selected() {
    document.getElementById("listit").disabled = true;
    document.getElementById("dnld").disabled = true;
    var id = []
    document.querySelectorAll('input[type=checkbox].video-item:checked').forEach(element => {
        id.push(element.id);
    })
    //console.log(id);
    fetch("/ytdiff/download", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            ids: id,
        })
    });
};

function clearSubList(force = false) {
    const table = document.getElementById("listing");
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
    if (force) {
        document.getElementById("start").value = 0;
        document.getElementById("stop").value = 10;
        document.getElementById("chunk").value = 10;
        document.getElementById("url").value = "";
        document.getElementById("selector").checked = false;
        document.getElementById("query").value = "";
        url_global = "None";
    }

};

function searchSub() {
    var query = document.getElementById("query").value.trim();
    var start = parseInt(document.getElementById("start").value, 10);
    var stop = parseInt(document.getElementById("stop").value, 10);
    // Setting start value
    if (isNaN(start)) {
        document.getElementById("start").value = 0;
        start = 0;
    }
    // Setting stop value
    if (isNaN(stop)) {
        document.getElementById("stop").value = chunk;
        stop = chunk;
    }
    // Setting url_global if it's not set already
    if ((url_global == "None") && (document.getElementById("url").value != "")) {
        url_global = document.getElementById("url").value;
    }
    //console.log("start: " + start + " stop: " + stop, "query: " + query);
    getSubList(url_global, start, stop, query);
};

function nextSub() {
    var query = document.getElementById("query").value.trim();
    var chunk = parseInt(document.getElementById("chunk").value, 10);
    var start = parseInt(document.getElementById("start").value, 10);
    var stop = parseInt(document.getElementById("stop").value, 10);
    // Setting start value
    if (isNaN(start)) {
        document.getElementById("start").value = 0;
        start = 0;
    } else {
        document.getElementById("start").value = start + chunk;
        start = start + chunk;
    }
    // Setting stop value
    if (isNaN(stop)) {
        document.getElementById("stop").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop").value = stop + chunk;
        stop = stop + chunk;
    }
    // Setting url_global if it's not set already
    if ((url_global == "None") && (document.getElementById("url").value != "")) {
        url_global = document.getElementById("url").value;
    }
    //console.log("start: " + start + " stop: " + stop, "query: " + query);
    getSubList(url_global, start, stop, query);
};
function backSub() {
    var query = document.getElementById("query").value.trim();
    var chunk = parseInt(document.getElementById("chunk").value, 10);
    var start = parseInt(document.getElementById("start").value, 10);
    var stop = parseInt(document.getElementById("stop").value, 10);
    // Setting start value
    if (isNaN(start) || ((start - chunk) <= 0)) {
        document.getElementById("start").value = 0;
        start = 0;
    } else {
        document.getElementById("start").value = start - chunk;
        start = start - chunk
    }
    // Setting stop value
    if (isNaN(stop) || ((stop - chunk) <= chunk)) {
        document.getElementById("stop").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop").value = stop - chunk;
        stop = stop - chunk;
    }
    // Setting url_global if it's not set already
    if ((url_global == "None") && (document.getElementById("url").value != "")) {
        url_global = document.getElementById("url").value;
    }
    //console.log("start: " + start + " stop: " + stop, "query: " + query);
    getSubList(url_global, start, stop, query);
};

function getSubList(url, start, stop, query_str) {
    //console.log("Querying url: ", url, " start: ", start, " stop: ", stop);
    fetch("/ytdiff/getsub", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            url: url,
            start: start,
            stop: stop,
            query: query_str
        })
    }).then((response) => response.text()).then((text) => makeSubTable(text));
};

function makeSubTable(text) {
    clearSubList();
    const table = document.getElementById("listing");
    //console.log(text);
    data = JSON.parse(text);
    //console.log(data);
    data["rows"].forEach(element => {
        /*
            # 	Title 	Downloaded 	Available
        */
        const row = table.insertRow();
        const select = row.insertCell(0);
        const title = row.insertCell(1);
        const download = row.insertCell(2);

        let checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "form-check-input me-1 video-item";
        checkbox.value = "";
        checkbox.id = element.id;

        let link = document.createElement('a');
        link.href = element.url;
        link.appendChild(document.createTextNode(element.title));
        select.className = "text-center";
        select.appendChild(checkbox);
        title.className = "large-title";
        title.appendChild(link);
        download.className = "emoji";
        if (element.downloaded) {
            download.innerHTML = "✅";
        } else {
            download.innerHTML = "❌";
        }
        if (element.downloaded) {
            row.className = "table-info";
        }
        if (!element.available) {
            if (element.title == "[Deleted video]")
                row.className = "table-danger";
            else if (element.title == "[Private video]")
                row.className = "table-warning"
            else
                row.className = "table-secondary"
        }
    });
}

function getOrphans() {
    var chunk = parseInt(document.getElementById("chunk").value, 10);
    var start = parseInt(document.getElementById("start").value, 10);
    var stop = parseInt(document.getElementById("stop").value, 10);
    // Setting start value
    if (isNaN(start) || ((start - chunk) <= 0)) {
        document.getElementById("start").value = 0;
        start = 0;
    } else {
        document.getElementById("start").value = start - chunk;
        start = start - chunk
    }
    // Setting stop value
    if (isNaN(stop) || ((stop - chunk) <= chunk)) {
        document.getElementById("stop").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop").value = stop - chunk;
        stop = stop - chunk;
    }
    // Setting url_global if it's not set already
    url_global = 'None';
    document.getElementById("query").value = "";
    document.getElementById("url").value = "";
    getSubList('None', start, stop, "");
};