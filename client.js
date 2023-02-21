function sockSetup() {
    console.log("Sock setup started");
    var socket = io({ path: "/ytdiff/socket.io/" });
    socket.on('init', function (data) {
        console.log(data.message);
        // Respond with a message including this clients' id sent from the server
        socket.emit('acknowledge', { data: 'Connected', id: data.id });
    });
    socket.on('download-start', function (data) {
        console.groupCollapsed(`Downloading: ${data.message}`);
    });
    socket.on('progress', function (data) {
        console.log(data.message);
    });
    socket.on('error', console.error.bind(console));
    socket.on('done', function (data) {
        console.log(`Downloaded: ${data.message} ✅`);
        console.groupEnd();
        var myToastEl = document.getElementById('notify');
        myToastEl.children[0].children[0].innerHTML = `${data.message} ✅`;
        var myToast = new bootstrap.Toast(myToastEl, {
            delay: 5000
        }); // Returns a Bootstrap toast instance
        myToast.show();
    });
};

function list_it() {
    // depopulateList(); // It actually isn't necessary
    var url = document.getElementById("url").value;
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
    console.log("URL: " + url, "Start: " + start, "Stop: " + stop, "Chunk size: " + chunk);
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
    }).then((response) => response.text()).then((text) => {
        response_list = JSON.parse(text);
        console.log(response_list['rows'], response_list['rows'].length)
        response_list['rows'].forEach(async element => {
            /*
                # 	Title 	Saved 	Avail.
            */
            const row = table.insertRow();
            const select = row.insertCell(0);
            const title = row.insertCell(1);
            const saved = row.insertCell(2);
            const avail = row.insertCell(3);

            let label = document.createElement("label");
            label.className = "list-group-item";

            let checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "form-check-input me-1";
            checkbox.value = "";
            checkbox.id = element['id'];

            let link = document.createElement('a');
            link.href = element['url'];
            link.appendChild(document.createTextNode(element['title']));
            // make it so if the saved is true it should be green and if the available is false it should be red
            select.appendChild(checkbox);
            title.appendChild(link);
            saved.innerHTML = element['downloaded'];
            avail.innerHTML = element['available'];
        });
        try {
            // Setting up the global url
            url_global = response_list['rows'][0]['reference'];
        } catch (error) {
            console.error(error);
        }
    });
};

function select_all() {
    document.querySelectorAll('input[type=checkbox]').forEach(element => {
        element.checked = true;
    });
};
function select_none() {
    document.querySelectorAll('input[type=checkbox]').forEach(element => {
        element.checked = false;
    });
};

function download_selected() {
    var id = []
    document.querySelectorAll('input[type=checkbox]:checked').forEach(element => {
        id.push(element.id);
    })
    // console.log(id);
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

function depopulateList(force = false) {
    const table = document.getElementById("listing");
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
    if (force) {
        document.getElementById("start").value = 0;
        document.getElementById("stop").value = 10;
        document.getElementById("chunk").value = 10;
        document.getElementById("url").value = "";
        url_global = "None";
    }

};

function nextSub() {
    depopulateList();
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
    console.log("In nextSub :", start, stop, chunk);
    getSubList(url_global, start, stop);
};
function backSub() {
    depopulateList();
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
    getSubList(url_global, start, stop);
};

function getSubList(url, start, stop) {
    console.log("Querying url: ", url, " start: ", start, " stop: ", stop);
    depopulateList();
    const table = document.getElementById("listing");
    fetch("/ytdiff/getsub", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            url: url,
            start: start,
            stop: stop
        })
    }).then((response) => response.text()).then((text) => {
        //console.log(text);
        data = JSON.parse(text);
        console.log(data);
        data["rows"].forEach(element => {
            /*
                # 	Title 	Downloaded 	Available
            */
            const row = table.insertRow();
            const select = row.insertCell(0);
            const title = row.insertCell(1);
            const download = row.insertCell(2);
            const status = row.insertCell(3);

            let checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "form-check-input me-1";
            checkbox.value = "";
            checkbox.id = element.id;

            let link = document.createElement('a');
            link.href = element.url;
            link.appendChild(document.createTextNode(element.title));
            select.appendChild(checkbox);
            title.appendChild(link);
            download.innerHTML = element.downloaded;
            status.innerHTML = element.available;
        });
    });
    // redundant init?
    // url_global = url;
};