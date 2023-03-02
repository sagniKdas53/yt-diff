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