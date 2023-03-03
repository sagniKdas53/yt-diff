// this if from the orphaned method
const chunk = parseInt(document.getElementById("chunk_sublist").value, 10);
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


// this is form getSubList originally
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