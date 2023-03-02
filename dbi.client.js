function sockSetup() {
    //console.log("Sock setup started");
    var socket = io({ path: "/ytdiff/socket.io/" });
    var myToastEl = document.getElementById('notify'),
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
        if (dnld_btn.disabled != true)
            dnld_btn.disabled = true;
        //console.log(data.message);
    });
    socket.on('error', console.error.bind(console));
    socket.on('download', function (data) {
        //console.log(`Downloaded: ${data.message} ✅`);
        //console.groupEnd();
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
        // list_btn.disabled = false;
        dnld_btn.disabled = false;
        myToastEl.children[0].children[0].innerHTML = `${data.message} ✅`;
        var myToast = new bootstrap.Toast(myToastEl, {
            delay: 5000
        }); // Returns a Bootstrap toast instance
        myToast.show();
    });
};
function nextMain() {
    depopulateMainList();
    var chunk = 10;
    //parseInt(document.getElementById("chunk-main").value, 10);
    var start = parseInt(document.getElementById("start_main").value, 10);
    var stop = parseInt(document.getElementById("stop_main").value, 10);
    var sort = document.getElementById("sort-by").value;
    var order = document.getElementById("order").value;
    // Setting start value
    if (isNaN(start)) {
        document.getElementById("start_main").value = 0;
        start = 0;
    } else {
        document.getElementById("start_main").value = start + chunk;
        start = start + chunk;
    }
    // Setting stop value
    if (isNaN(stop)) {
        document.getElementById("stop_main").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_main").value = stop + chunk;
        stop = stop + chunk;
    }
    getMainlist(start, stop, sort, order);
};
function backMain() {
    depopulateMainList();
    var chunk = 10;
    //parseInt(document.getElementById("chunk-main").value, 10);
    var start = parseInt(document.getElementById("start_main").value, 10);
    var stop = parseInt(document.getElementById("stop_main").value, 10);
    var sort = document.getElementById("sort-by").value;
    var order = document.getElementById("order").value;
    // Setting start value
    if (isNaN(start) || ((start - chunk) <= 0)) {
        document.getElementById("start_main").value = 0;
        start = 0;
    } else {
        document.getElementById("start_main").value = start - chunk;
        start = start - chunk
    }
    // Setting stop value
    if (isNaN(stop) || ((stop - chunk) <= chunk)) {
        document.getElementById("stop_main").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_main").value = stop - chunk;
        stop = stop - chunk;
    }
    getMainlist(start, stop, sort, order);
};

function sortLoaded() {
    depopulateMainList();
    var sort = document.getElementById("sort-by").value;
    var order = document.getElementById("order").value;
    var start = parseInt(document.getElementById("start_main").value, 10);
    var stop = parseInt(document.getElementById("stop_main").value, 10);
    getMainlist(start, stop, sort, order);
}
function getMainlist(start_val, stop_val, sort_val, order_val) {
    const options = { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric' };
    //console.log("Start: " + start_val + " stop: " + stop_val);
    fetch("/ytdiff/dbi", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },

        //make sure to serialize your JSON body
        body: JSON.stringify({
            start: start_val, // get these later from the document
            stop: stop_val,
            sort: sort_val,
            order: order_val
        })
    }).then((response) => response.text()).then((text) => {
        text = JSON.parse(text)
        const table = document.getElementById("placeholder");
        text['rows'].forEach(element => {
            // console.log(element);
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
            url.innerHTML = `<a href='${element.url}'">${element.title}</a>`;
            //overflow-wrap: break-word;width;word-wrap: anywhere;width: 17vw;
            //url.style.wordWrap = "anywhere";
            //url.style.width = "17vw";
            createdAt.innerHTML = new Date(element.createdAt).toLocaleDateString("en-US", options);
            updatedAt.innerHTML = new Date(element.updatedAt).toLocaleDateString("en-US", options);
            show.innerHTML = '<button type="button" class="btn btn-secondary" onclick=getSubList("' + element.url + '")>Load</button>';
        });
    });
};
function depopulateMainList() {
    const table = document.getElementById("placeholder");
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
};
function getOrphans() {
    var chunk = parseInt(document.getElementById("chunk").value, 10);
    var start = parseInt(document.getElementById("start_sub").value, 10);
    var stop = parseInt(document.getElementById("stop_sub").value, 10);
    // Setting start value
    if (isNaN(start) || ((start - chunk) <= 0)) {
        document.getElementById("start_sub").value = 0;
        start = 0;
    } else {
        document.getElementById("start_sub").value = start - chunk;
        start = start - chunk
    }
    // Setting stop value
    if (isNaN(stop) || ((stop - chunk) <= chunk)) {
        document.getElementById("stop_sub").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_sub").value = stop - chunk;
        stop = stop - chunk;
    }
    // Setting url_global if it's not set already
    url_global = 'None';
    getSubList('None', start, stop, "", true);
};

//Sub list stuff
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

function depopulateList(force = false) {
    const table = document.getElementById("listing");
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
    if (force) {
        document.getElementById("start_sub").value = 0;
        document.getElementById("stop_sub").value = 10;
        document.getElementById("chunk").value = 10;
        url_global = "None";
    }

};

function searchSub() {
    var query = document.getElementById("query").value.trim();
    var start = parseInt(document.getElementById("start_sub").value, 10);
    var stop = parseInt(document.getElementById("stop_sub").value, 10);
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
    var query = document.getElementById("query").value.trim();
    var chunk = parseInt(document.getElementById("chunk").value, 10);
    var start = parseInt(document.getElementById("start_sub").value, 10);
    var stop = parseInt(document.getElementById("stop_sub").value, 10);
    // Setting start value
    if (isNaN(start)) {
        document.getElementById("start_sub").value = 0;
        start = 0;
    } else {
        document.getElementById("start_sub").value = start + chunk;
        start = start + chunk;
    }
    // Setting stop value
    if (isNaN(stop)) {
        document.getElementById("stop_sub").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_sub").value = stop + chunk;
        stop = stop + chunk;
    }
    getSubList(url_global, start, stop, query, false);
};
function backSub() {
    var query = document.getElementById("query").value.trim();
    var chunk = parseInt(document.getElementById("chunk").value, 10);
    var start = parseInt(document.getElementById("start_sub").value, 10);
    var stop = parseInt(document.getElementById("stop_sub").value, 10);
    // Setting start value
    if (isNaN(start) || ((start - chunk) <= 0)) {
        document.getElementById("start_sub").value = 0;
        start = 0;
    } else {
        document.getElementById("start_sub").value = start - chunk;
        start = start - chunk
    }
    // Setting stop value
    if (isNaN(stop) || ((stop - chunk) <= chunk)) {
        document.getElementById("stop_sub").value = chunk;
        stop = chunk;
    } else {
        document.getElementById("stop_sub").value = stop - chunk;
        stop = stop - chunk;
    }
    getSubList(url_global, start, stop, query, false);
};

function getSubList(url, start, stop, query_str, clear_search = true) {
    if (start == undefined && stop == undefined) {
        var chunk = parseInt(document.getElementById("chunk").value, 10),
            start = parseInt(document.getElementById("start_sub").value, 10),
            stop = parseInt(document.getElementById("stop_sub").value, 10);
        // Setting start value
        if (isNaN(start)) {
            document.getElementById("start_sub").value = 0;
            start = 0;
        }
        // Setting stop value
        if (isNaN(stop)) {
            document.getElementById("stop_sub").value = chunk;
            stop = chunk;
        } else {
            stop = start + chunk;
            document.getElementById("stop_sub").value = stop;
        }
    }
    if (url_global != url) {
        url_global = url;
    }
    //console.log("clear_search", clear_search);
    if (clear_search) {
        document.getElementById("query").value = "";
        query_str = "";
    }
    //console.log("Querying url: ", url_global, " start: ", start, " stop: ", stop);
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
            stop: stop,
            query: query_str
        })
    }).then((response) => response.text()).then((text) => makeTable(text));
};

function makeTable(text) {
    depopulateList();
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

function download_selected() {
    document.getElementById("dnld").disabled = true;
    var id = []
    document.querySelectorAll('input[type=checkbox].video-item:checked').forEach(element => {
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