(function () {
  "use strict";

  var COLUMNS = [
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing" },
    { id: "done", label: "Done" },
  ];

  var boardEl = document.getElementById("board");
  var cardTemplate = document.getElementById("card-template");
  var dragCardId = null;
  var latestBoard = { columns: { todo: [], doing: [], done: [] } };

  function render(board) {
    latestBoard = board && board.columns ? board : { columns: { todo: [], doing: [], done: [] } };
    boardEl.innerHTML = "";
    COLUMNS.forEach(function (column) {
      boardEl.appendChild(renderColumn(column));
    });
  }

  function renderColumn(column) {
    var cards = latestBoard.columns[column.id] || [];

    var columnEl = document.createElement("div");
    columnEl.className = "column";

    var header = document.createElement("div");
    header.className = "column-header";
    var title = document.createElement("span");
    title.className = "column-title";
    title.textContent = column.label + " (" + cards.length + ")";
    header.appendChild(title);
    columnEl.appendChild(header);

    var list = document.createElement("div");
    list.className = "card-list";
    list.dataset.column = column.id;
    list.addEventListener("dragover", onDragOverList);
    list.addEventListener("drop", onDropOnList);
    cards.forEach(function (card) {
      list.appendChild(renderCard(card));
    });
    columnEl.appendChild(list);

    columnEl.appendChild(renderAddCardForm(column.id));
    return columnEl;
  }

  function renderCard(card) {
    var node = cardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = card.id;
    node.querySelector(".card-title").textContent = card.title;
    var descEl = node.querySelector(".card-description");
    if (card.description) {
      descEl.textContent = card.description;
    } else {
      descEl.remove();
    }

    node.addEventListener("dragstart", function (event) {
      dragCardId = card.id;
      event.dataTransfer.setData("text/plain", card.id);
      event.dataTransfer.effectAllowed = "move";
    });
    node.addEventListener("dragend", function () {
      dragCardId = null;
    });

    node.querySelector(".card-remove").addEventListener("click", function () {
      window.canvas.send({ type: "remove", id: card.id });
    });
    node.querySelector(".card-edit").addEventListener("click", function () {
      replaceWithEditor(node, card);
    });

    return node;
  }

  function replaceWithEditor(cardNode, card) {
    var editor = document.createElement("div");
    editor.className = "card card-editor";

    var titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = card.title;
    titleInput.className = "card-editor-title";

    var descInput = document.createElement("textarea");
    descInput.value = card.description || "";
    descInput.className = "card-editor-description";
    descInput.placeholder = "Description (optional)";

    var actions = document.createElement("div");
    actions.className = "card-actions";

    var save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    save.addEventListener("click", function () {
      var title = titleInput.value.trim();
      if (!title) return;
      window.canvas.send({ type: "update", id: card.id, title: title, description: descInput.value.trim() });
    });

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function () {
      render(latestBoard);
    });

    actions.appendChild(save);
    actions.appendChild(cancel);
    editor.appendChild(titleInput);
    editor.appendChild(descInput);
    editor.appendChild(actions);

    cardNode.replaceWith(editor);
    titleInput.focus();
  }

  function renderAddCardForm(columnId) {
    var wrapper = document.createElement("div");
    wrapper.className = "add-card";

    var button = document.createElement("button");
    button.type = "button";
    button.className = "add-card-toggle";
    button.textContent = "+ Add card";

    var form = document.createElement("form");
    form.className = "add-card-form hidden";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Card title";
    var submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add";

    form.appendChild(input);
    form.appendChild(submit);

    button.addEventListener("click", function () {
      button.classList.add("hidden");
      form.classList.remove("hidden");
      input.focus();
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var title = input.value.trim();
      if (!title) return;
      window.canvas.send({ type: "add", column: columnId, title: title });
      input.value = "";
      form.classList.add("hidden");
      button.classList.remove("hidden");
    });

    wrapper.appendChild(button);
    wrapper.appendChild(form);
    return wrapper;
  }

  function onDragOverList(event) {
    event.preventDefault();
  }

  function onDropOnList(event) {
    event.preventDefault();
    var id = dragCardId || event.dataTransfer.getData("text/plain");
    if (!id) return;
    var list = event.currentTarget;
    var toColumn = list.dataset.column;
    var toIndex = computeDropIndex(list, event.clientY);
    window.canvas.send({ type: "move", id: id, to: toColumn, toIndex: toIndex });
  }

  function computeDropIndex(list, clientY) {
    var cards = Array.prototype.slice.call(list.querySelectorAll(".card"));
    for (var i = 0; i < cards.length; i++) {
      var rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return cards.length;
  }

  window.canvas.onState(function (state) {
    render(state);
  });
})();
