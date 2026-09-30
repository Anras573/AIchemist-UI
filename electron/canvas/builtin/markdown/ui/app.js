(function () {
  "use strict";

  var previewEl = document.getElementById("preview");
  var editorEl = document.getElementById("editor");
  var toggleBtn = document.getElementById("toggle");
  var saveBtn = document.getElementById("save");
  var content = "";
  var editing = false;

  // Small, dependency-free markdown subset (headings, lists, fenced code,
  // bold/italic/inline code, paragraphs). Everything is built with DOM nodes
  // + textContent — never innerHTML — so document text can't inject markup.
  function inline(parent, text) {
    var re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      var el;
      if (tok[0] === "`") {
        el = document.createElement("code");
        el.textContent = tok.slice(1, -1);
      } else if (tok.slice(0, 2) === "**") {
        el = document.createElement("strong");
        el.textContent = tok.slice(2, -2);
      } else {
        el = document.createElement("em");
        el.textContent = tok.slice(1, -1);
      }
      parent.appendChild(el);
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(source) {
    previewEl.innerHTML = "";
    if (!source.trim()) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Empty document.";
      previewEl.appendChild(empty);
      return;
    }
    var lines = source.split("\n");
    var i = 0;
    var list = null;
    while (i < lines.length) {
      var line = lines[i];
      var heading = /^(#{1,3})\s+(.*)$/.exec(line);
      var bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (line.indexOf("```") === 0) {
        list = null;
        var code = [];
        i++;
        while (i < lines.length && lines[i].indexOf("```") !== 0) {
          code.push(lines[i]);
          i++;
        }
        var pre = document.createElement("pre");
        var codeEl = document.createElement("code");
        codeEl.textContent = code.join("\n");
        pre.appendChild(codeEl);
        previewEl.appendChild(pre);
      } else if (heading) {
        list = null;
        var h = document.createElement("h" + heading[1].length);
        inline(h, heading[2]);
        previewEl.appendChild(h);
      } else if (bullet) {
        if (!list) {
          list = document.createElement("ul");
          previewEl.appendChild(list);
        }
        var li = document.createElement("li");
        inline(li, bullet[1]);
        list.appendChild(li);
      } else if (line.trim()) {
        list = null;
        var p = document.createElement("p");
        inline(p, line);
        previewEl.appendChild(p);
      } else {
        list = null;
      }
      i++;
    }
  }

  function setEditing(next) {
    editing = next;
    previewEl.classList.toggle("hidden", editing);
    editorEl.classList.toggle("hidden", !editing);
    saveBtn.classList.toggle("hidden", !editing);
    toggleBtn.textContent = editing ? "Cancel" : "Edit";
    if (editing) {
      editorEl.value = content;
      editorEl.focus();
    }
  }

  toggleBtn.addEventListener("click", function () {
    setEditing(!editing);
  });
  saveBtn.addEventListener("click", function () {
    window.canvas.send({ type: "set", content: editorEl.value });
    setEditing(false);
  });

  window.canvas.onState(function (state) {
    content = state && typeof state.content === "string" ? state.content : "";
    renderMarkdown(content);
  });
})();
