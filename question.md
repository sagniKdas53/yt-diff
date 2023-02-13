# Why does this

```css
.list-table {
  max-height: 80vh;
  overflow-y: scroll;
  padding-bottom: 15px;
}
```

```html
<div class="col">
  <h3>List:</h3>
  <table class="table">
    <thead>
      <tr>
        <th scope="col">#</th>
        <th scope="col">Title</th>
      </tr>
    </thead>
    <div class="list-table">
      <tbody id="listing">
        <!--all items would be added here
                            get the pagenition to work also make only the tbody
                            scrollable not the entire table-->
      </tbody>
    </div>
  </table>
</div>
```

Become this automatically in browser

```html
<div class="col">
  <h3>List:</h3>
  <div class="list-table"></div>
  <table class="table">
    <thead>
      <tr>
        <th scope="col">#</th>
        <th scope="col">Title</th>
      </tr>
    </thead>
    <tbody id="listing">
      <!--all items would be added here
                            get the pagenition to work also make only the tbody
                            scrollable not the entire table-->
    </tbody>
  </table>
</div>
```
