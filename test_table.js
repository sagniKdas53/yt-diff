function test_table() {
    const table = document.getElementById("listing");
    for (let index = 0; index < 23; index++) {
        const row = table.insertRow();
        const select = row.insertCell(0);
        const title = row.insertCell(1);


        let label = document.createElement("label");
        label.className = "list-group-item";

        let checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "form-check-input me-1";
        checkbox.value = "";
        checkbox.id = index;

        let link = document.createElement('a');
        link.href = index;
        link.appendChild(document.createTextNode(index));

        select.appendChild(checkbox);
        title.appendChild(link);
    }
}