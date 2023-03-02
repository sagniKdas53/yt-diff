function sockSetup() {
    //console.log("Sock setup started");
    const socket = io({ path: "/ytdiff/socket.io/" });
    const list_btn = document.getElementById("listit") || { disabled: false };
    const dnld_btn = document.getElementById("download_btn");
    socket.on("init", function (data) {
        // Need to make it so that the "acknowledge" is used somehow.
        socket.emit("acknowledge", { data: "Connected", id: data.id });
    });
    socket.on("download-start", function (data) {
        //console.groupCollapsed(`Downloading: ${data.message}`);
        if (list_btn.disabled != true && dnld_btn.disabled != true) {
            list_btn.disabled = true;
            dnld_btn.disabled = true;
        }
    });
    socket.on("progress", function (data) {
        //console.log(data.message);
        if (list_btn.disabled != true && dnld_btn.disabled != true) {
            list_btn.disabled = true;
            dnld_btn.disabled = true;
        }
    });
    socket.on("error", console.error.bind(console));
    socket.on("download", function (data) {
        //console.log(`Downloaded: ${data.message} ✅`);
        //console.groupEnd();
        list_btn.disabled = false;
        dnld_btn.disabled = false;
        showToast(`${data.message} ✅`);
    });
    socket.on("playlist", function (data) {
        //console.log(`Playlist: ${data.message} ✅`);
        //console.groupEnd();
        list_btn.disabled = false;
        dnld_btn.disabled = false;
        showToast(`${data.message} ✅`);
    });
};
function showToast(text) {
    const myToastEl = document.getElementById("notify");
    myToastEl.children[0].children[0].innerHTML = text;
    new bootstrap.Toast(myToastEl, {
        delay: 5000
    }).show();
}

// Mail list methods
function getMainList(start_val, stop_val) {
    const sort_val = document.getElementById("sort_by_playlist").value;
    const order_val = document.getElementById("order_by_playlist").value;
    //console.log("Start: " + start_val + " stop: " + stop_val);
    fetch("/ytdiff/dbi", {
        method: "post",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            start: start_val,
            stop: stop_val,
            sort: sort_val,
            order: order_val
        })
    }).then((response) => response.text()).then(makeMainTable);
};
function makeMainTable(text) {
    const table = document.getElementById("placeholder");
    // It feels that clearing the table before parsing the JSON makes it seem less laggy
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
    text = JSON.parse(text)
    const options = { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric" };
    text["rows"].forEach(element => {
        /*
        id 	url 	createdAt 	updatedAt 	more
        */
        const row = table.insertRow();
        const id = row.insertCell(0);
        const url = row.insertCell(1);
        const createdAt = row.insertCell(2);
        const updatedAt = row.insertCell(3);
        const show = row.insertCell(4);

        id.innerHTML = element.order_added;
        url.innerHTML = `<a href="${element.url}">${element.title}</a>`;
        createdAt.innerHTML = new Date(element.createdAt).toLocaleDateString("en-US", options);
        updatedAt.innerHTML = new Date(element.updatedAt).toLocaleDateString("en-US", options);
        // single quotes are necessary here
        show.innerHTML = '<button type="button" class="btn btn-secondary" onclick=getSubList("' + element.url + '")>Load</button>';
    });
}

function nextMain() {
    var start = parseInt(document.getElementById("start_playlist").value, 10);
    var stop = parseInt(document.getElementById("stop_playlist").value, 10);
    const chunk = parseInt(document.getElementById("chunk_playlist").value, 10);
    // Setting start value
    if (isNaN(start)) {
        document.getElementById("start_playlist").value = 0;
        start = 0;
    } else {
        document.getElementById("start_playlist").value = start + chunk;
        start = start + chunk;
    }
    // Setting stop value
    if (isNaN(stop)) {
        document.getElementById("stop_playlist").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_playlist").value = stop + chunk;
        stop = stop + chunk;
    }
    getMainList(start, stop);
};
function backMain() {
    var start = parseInt(document.getElementById("start_playlist").value, 10);
    var stop = parseInt(document.getElementById("stop_playlist").value, 10);
    const chunk = parseInt(document.getElementById("chunk_playlist").value, 10);
    // Setting start value
    if (isNaN(start) || ((start - chunk) <= 0)) {
        document.getElementById("start_playlist").value = 0;
        start = 0;
    } else {
        document.getElementById("start_playlist").value = start - chunk;
        start = start - chunk
    }
    // Setting stop value
    if (isNaN(stop) || ((stop - chunk) <= chunk)) {
        document.getElementById("stop_playlist").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_playlist").value = stop - chunk;
        stop = stop - chunk;
    }
    getMainList(start, stop);
};
function sortLoaded() {
    const start = parseInt(document.getElementById("start_playlist").value, 10);
    const stop = parseInt(document.getElementById("stop_playlist").value, 10);
    getMainList(start, stop);
}

//Sub list methods
function getSubList(url, start_val, stop_val, query_str = "", clear_query = true) {
    // Getting the start and stop values
    if (start_val == undefined || stop_val == undefined) {
        start_val = parseInt(document.getElementById("start_sublist").value, 10);
        stop_val = parseInt(document.getElementById("stop_sublist").value, 10);
        const chunk = parseInt(document.getElementById("chunk_sublist").value, 10);
        // Setting start value if it's not set in DOM yet
        if (isNaN(start_val)) {
            document.getElementById("start_sublist").value = 0;
            start_val = 0;
        }
        // Setting stop value if it's not set in DOM yet
        if (isNaN(stop_val)) {
            stop_val = start_val + chunk;
            document.getElementById("stop_sublist").value = stop_val;
        }
    }
    // Setting the url_global variable so that next request can use it again
    if (url_global != url) {
        url_global = url;
    }
    // Checking the clear_query and modifying it
    if (clear_query) {
        document.getElementById("query_sublist").value = "";
        query_str = "";
    }
    //console.log("Getting url: ", url_global, " start: ", start, " stop: ", stop, "query: ", query_str);
    fetch("/ytdiff/getsub", {
        method: "post",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            url: url,
            start: start_val,
            stop: stop_val,
            query: query_str
        })
    }).then((response) => response.text()).then(makeSubTable);
};
function makeSubTable(text) {
    clearSubList();
    const table = document.getElementById("listing");
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

        let link = document.createElement("a");
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
};
function clearSubList(reset = false) {
    const table = document.getElementById("listing");
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
    if (reset) {
        document.getElementById("start_sublist").value = 0;
        document.getElementById("stop_sublist").value = 10;
        document.getElementById("chunk_sublist").value = 10;
        url_global = "None";
    }
};
function select_all() {
    document.querySelectorAll("input[type=checkbox].video-item").forEach(element => {
        element.checked = true;
    });
};
function select_none() {
    document.querySelectorAll("input[type=checkbox].video-item").forEach(element => {
        element.checked = false;
    });
};

// Do from here on out
function searchSub() {
    var query = document.getElementById("query_sublist").value.trim();
    var start = parseInt(document.getElementById("start_sublist").value, 10);
    var stop = parseInt(document.getElementById("stop_sublist").value, 10);
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
    //console.log("start: " + start + " stop: " + stop, "query: " + query);
    getSubList(url_global, start, stop, query, false);
};

function nextSub() {
    var query = document.getElementById("query_sublist").value.trim();
    var chunk = parseInt(document.getElementById("chunk_sublist").value, 10);
    var start = parseInt(document.getElementById("start_sublist").value, 10);
    var stop = parseInt(document.getElementById("stop_sublist").value, 10);
    // Setting start value
    if (isNaN(start)) {
        document.getElementById("start_sublist").value = 0;
        start = 0;
    } else {
        document.getElementById("start_sublist").value = start + chunk;
        start = start + chunk;
    }
    // Setting stop value
    if (isNaN(stop)) {
        document.getElementById("stop_sublist").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_sublist").value = stop + chunk;
        stop = stop + chunk;
    }
    getSubList(url_global, start, stop, query, false);
};
function backSub() {
    var query = document.getElementById("query_sublist").value.trim();
    var chunk = parseInt(document.getElementById("chunk_sublist").value, 10);
    var start = parseInt(document.getElementById("start_sublist").value, 10);
    var stop = parseInt(document.getElementById("stop_sublist").value, 10);
    // Setting start value
    if (isNaN(start) || ((start - chunk) <= 0)) {
        document.getElementById("start_sublist").value = 0;
        start = 0;
    } else {
        document.getElementById("start_sublist").value = start - chunk;
        start = start - chunk
    }
    // Setting stop value
    if (isNaN(stop) || ((stop - chunk) <= chunk)) {
        document.getElementById("stop_sublist").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_sublist").value = stop - chunk;
        stop = stop - chunk;
    }
    getSubList(url_global, start, stop, query, false);
};

function download_selected() {
    document.getElementById("download_btn").disabled = true;
    var id = []
    document.querySelectorAll("input[type=checkbox].video-item:checked").forEach(element => {
        id.push(element.id);
    })
    // console.log(id);
    fetch("/ytdiff/download", {
        method: "post",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            ids: id,
        })
    });
};