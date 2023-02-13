function post() {
    var url = document.getElementById("url").value;
    var start = document.getElementById("start").value;
    var stop = document.getElementById("stop").value;
    const table = document.getElementById("listing");
    console.log("URL: " + url, "Start: " + start, "Stop: " + stop);//, "Single: " + single);
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
            stop: stop
        })
    }).then((response) => response.text()).then((text) => {
        response_list = text.slice(0, -2).split("\n").slice(0, -1);
        console.log(response_list, response_list.length)

        response_list.forEach(async element => {
            var items = element.split("\t");
            console.log(items, items.length);
            /*
                # 	Title 
            */
            const row = table.insertRow();
            const select = row.insertCell(0);
            const title = row.insertCell(1);


            let label = document.createElement("label");
            label.className = "list-group-item";

            let checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.className = "form-check-input me-1";
            checkbox.value = "";
            checkbox.id = items[1];

            let link = document.createElement('a');
            link.href = items[2];
            link.appendChild(document.createTextNode(items[0]));

            select.appendChild(checkbox);
            title.appendChild(link);
            //output.appendChild(label);
        });
    });
};

function select_all() {
    document.querySelectorAll('input[type=checkbox]').forEach(element => {
        element.checked = true;
    });
}

function select_none() {
    document.querySelectorAll('input[type=checkbox]').forEach(element => {
        element.checked = false;
    });
}

function download() {
    var id = []
    document.querySelectorAll('input[type=checkbox]:checked')
        .forEach(element => {
            id.push(element.id);
        })
    console.log(id);
    fetch("/ytdiff/download", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        //make sure to serialize your JSON body
        body: JSON.stringify({
            ids: id,
        })
    }).then((response) => response.text()).then((text) => {
        console.log(text);
    });
    //set up a websocket to check on the status although it won't be really useful
}

function sockSetup() {
    console.log("Sock setup started");
    var socket = io();
    socket.on('init', function (data) {
        console.log(data.message);
        // Respond with a message including this clients' id sent from the server
        socket.emit('acknowledge', { data: 'Connected', id: data.id });
    });
    socket.on('progress', function (data) {
        console.log(data);
    });
    socket.on('error', console.error.bind(console));
    socket.on('done', function (data) {
        console.log(data.message);
        alert('Downloaded: ' + `${data.message}`);
    });
}


function init() {
    if (document.getElementById("start").value === "") {
        document.getElementById("start").value = 0;
    }
    if (document.getElementById("stop").value === "") {
        document.getElementById("stop").value = 10;
    }
    populateList();
    sockSetup();
}
function sockSetup() {
    console.log("Sock setup started");
    var socket = io();
    socket.on('init', function (data) {
        console.log(data.message);
        // Respond with a message including this clients' id sent from the server
        socket.emit('acknowledge', { data: 'Connected', id: data.id });
    });
    socket.on('progress', function (data) {
        console.log(data);
    });
    socket.on('error', console.error.bind(console));
    socket.on('message', console.log.bind(console));
}
function next() {
    depopulateList();
    if (document.getElementById("start").value === "") {
        document.getElementById("start").value = 0;
    } else {
        document.getElementById("start").value = parseInt(document.getElementById("start").value, 10) + 10;
    }
    if (document.getElementById("stop").value === "") {
        document.getElementById("stop").value = 10;
    } else {
        document.getElementById("stop").value = parseInt(document.getElementById("stop").value, 10) + 10;
    }
    populateList();
}
function back() {
    depopulateList();

    if (document.getElementById("start").value === "") {
        document.getElementById("start").value = 0;
    } else if ((parseInt(document.getElementById("start").value, 10) - 10) <= 0) {
        document.getElementById("start").value = 0;
    } else {
        document.getElementById("start").value = parseInt(document.getElementById("start").value, 10) - 10;
    }

    if (document.getElementById("stop").value === "") {
        document.getElementById("stop").value = 10;
    } else if ((parseInt(document.getElementById("stop").value, 10) - 10) <= 10) {
        document.getElementById("stop").value = 10;
    } else {
        document.getElementById("stop").value = parseInt(document.getElementById("stop").value, 10) - 10;
    }

    populateList();
}
function populateList() {
    const options = { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric' };
    var start_val = document.getElementById("start").value;
    var stop_val = document.getElementById("stop").value;
    console.log("Start: " + start_val + " stop: " + stop_val);
    fetch("/ytdiff/showdb", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },

        //make sure to serialize your JSON body
        body: JSON.stringify({
            start: start_val, // get these later from the document
            stop: stop_val
        })
    }).then((response) => response.text()).then((text) => {
        text = JSON.parse(text)
        const table = document.getElementById("placeholder");
        text['rows'].forEach(element => {
            console.log(element);
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
            /*
            Add the more button that loads the list of vidoes associted with the playlist 
            and add the download buttons here too also make sure to add the web sockets
            */
        });
    });
};
function depopulateList() {
    const table = document.getElementById("placeholder");
    for (var i = 1; i < table.rows.length;) {
        table.deleteRow(i);
    }
};
function getSubList(url) {
    console.log(url);
    var start = document.getElementById("start_sub").value;
    var stop = document.getElementById("stop_sub").value;
    const table = document.getElementById("listing");
    fetch("/ytdiff/getsub", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },

        //make sure to serialize your JSON body
        body: JSON.stringify({
            url: url,
            start: start,
            stop: stop
        })
    }).then((response) => response.text()).then((text) => {
        //console.log(text);
        data = JSON.parse(text);
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
    url_global = url;
};

function select_all() {
    document.querySelectorAll('input[type=checkbox]').forEach(element => {
        element.checked = true;
    });
}

function select_none() {
    document.querySelectorAll('input[type=checkbox]').forEach(element => {
        element.checked = false;
    });
}

function depopulateSubList() {
    const table = document.getElementById("listing");
    for (var i = 1; i < table.rows.length;) {
        table.deleteRow(i);
    }
};

function download() {
    var id = []
    document.querySelectorAll('input[type=checkbox]:checked')
        .forEach(element => {
            id.push(element.id);
        })
    console.log(id);
    fetch("/ytdiff/download", {
        method: "post",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        //make sure to serialize your JSON body
        body: JSON.stringify({
            ids: id,
        })
    }).then((response) => response.text()).then((text) => {
        console.log(text);
    });
    //set up a websocket to check on the status although it won't be really useful
}

function next_sub() {
    if (document.getElementById("start_sub").value === "") {
        document.getElementById("start_sub").value = 0;
    } else {
        document.getElementById("start_sub").value = parseInt(document.getElementById("start_sub").value, 10) + 10;
    }
    if (document.getElementById("stop_sub").value === "") {
        document.getElementById("stop_sub").value = 10;
    } else {
        document.getElementById("stop_sub").value = parseInt(document.getElementById("stop_sub").value, 10) + 10;
    }
    getSubList(url_global);
}
function back_sub() {
    if (document.getElementById("start_sub").value === "") {
        document.getElementById("start_sub").value = 0;
    } else if ((parseInt(document.getElementById("start_sub").value, 10) - 10) <= 0) {
        document.getElementById("start_sub").value = 0;
    } else {
        document.getElementById("start_sub").value = parseInt(document.getElementById("start_sub").value, 10) - 10;
    }

    if (document.getElementById("stop_sub").value === "") {
        document.getElementById("stop_sub").value = 10;
    } else if ((parseInt(document.getElementById("stop_sub").value, 10) - 10) <= 10) {
        document.getElementById("stop_sub").value = 10;
    } else {
        document.getElementById("stop_sub").value = parseInt(document.getElementById("stop_sub").value, 10) - 10;
    }
    getSubList(url_global);
}