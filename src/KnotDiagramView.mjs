import {assert, hex_to_rgb, toString} from "./util.mjs";
import {KnotGraph} from "./knotgraph.mjs";
import {P,X,Virtual} from "./pd.mjs";
import {Point, segment_distance, point_along} from "./geom2d.mjs";
import {CROSSING_CHANGE_RADIUS, DIAGRAM_LINE_WIDTH, CROSSING_GAP, VIRTUAL_RADIUS, palette} from "./constants.mjs";
import {KnotRasterView} from "./KnotRasterView.mjs";
import {get_invariant} from "./invariants.mjs";
import {Laurent} from "./laurent.mjs";
import Q from "./kq.mjs";
import {signature} from "./matrix.mjs";
import {arrow_varnames} from "./atl.mjs";
import * as expr from "./expr.mjs";
import {show_export_dialog, plain_label} from "./vectorexport.mjs";

const LABEL_OFFSET = 16; // distance from the curve (in diagram pixels) for new framing labels
const LABEL_GRAB_RADIUS = 14; // how close a click must be to a label to grab it
const DOT_RADIUS = 5;

let global_tool_state = {
  tool: "crossing-change"
};

let default_pd_type = "KnotTheory";
let default_laurent_type = "DOM";

let global_details_states = {
  "linking-matrix": true,
  "seifert-matrix": false,
  "alexander-module": false
};
function attach_details_handler(name, $details) {
  let initial_state = Boolean(global_details_states[name]);
  $details.prop("open", initial_state);
  $details.on("toggle", e => {
    global_details_states[name] = $details.prop("open");
  });
}

export class KnotDiagramView {
  constructor(width, height, diagram, calculate_invariants) {
    assert(width > 0);
    assert(height > 0);
    assert(diagram instanceof KnotGraph);
    this.width = width;
    this.height = height;
    this.diagram = diagram;
    this.calculate_invariants = calculate_invariants;

    this.c = new Point(0, 0);
    this.zoom = 1;
    this.moving = null; // if we are currently translating the diagram, is a Point
    this.dragging = null; // if we are currently dragging a Kirby label, {view, index, start, moved}

    if (this.calculate_invariants) {
      this.mode_name = "Diagrams"; // constant
    } else {
      this.mode_name = "Diagrams (no invariants)";
    }
  }

  copy(calculate_invariants) {
    let view = new KnotDiagramView(this.width, this.height, this.diagram.copy(), this.calculate_invariants || calculate_invariants);
    view.c = this.c.copy();
    view.zoom = this.zoom;
    return view;
  }

  reset_zoom() {
    this.c = new Point(0, 0);
    this.zoom = 1;
  }

  mouse_to_pt(pt) {
    assert(pt instanceof Point);
    return new Point(this.zoom*(pt.x - this.c.x), this.zoom*(pt.y - this.c.y));
  }

  find_closest_crossing(pt) {
    /* Returns a vertex id for the diagram, or null.  Gets a non-P vertex. */
    let diag = this.diagram;
    let dist = CROSSING_CHANGE_RADIUS*this.zoom;
    let closest = null;
    diag.verts.forEach((vert, vid) => {
      if (!(diag.adjs[vid] instanceof P)) {
        let d = Point.dist(pt, vert);
        if (d <= dist) {
          dist = d;
          closest = vid;
        }
      }
    });
    return closest;
  }
  
  draw_crossing_disk(ctxt, cpt) {
    let getX = (x) => {
      return x/this.zoom+this.c.x;
    };
    let getY = (y) => {
      return y/this.zoom+this.c.y;
    };
    ctxt.save();
    ctxt.fillStyle = "#0000ff";
    ctxt.globalAlpha = 0.2;
    ctxt.beginPath();
    ctxt.arc(getX(cpt.x)+0.5, getY(cpt.y)+0.5, CROSSING_CHANGE_RADIUS, 0, 2*Math.PI);
    ctxt.fill();
    ctxt.restore();
  }

  find_closest_circuit(pt) {
    /* Returns a list of darts of the closest circuit to the given point. */
    let diag = this.diagram;
    let dist = 3*DIAGRAM_LINE_WIDTH*this.zoom;
    let closest_eid = null;
    diag.edges.forEach((edge, eid) => {
      let d = segment_distance(diag.verts[edge[0]], diag.verts[edge[1]], pt);
      if (d <= dist) {
        dist = d;
        closest_eid = eid;
      }
    });
    if (closest_eid == null) {
      return null;
    }
    return diag.dart_circuit(closest_eid+1);
  }
  highlight_circuit(ctxt, circuit) {
    let getX = (x) => {
      return x/this.zoom+this.c.x;
    };
    let getY = (y) => {
      return y/this.zoom+this.c.y;
    };

    let diag = this.diagram;
    let pts = circuit.map(dart => diag.verts[diag.dart_start(dart)]);
    ctxt.save();
    ctxt.strokeStyle = "#0000ff";
    ctxt.globalAlpha = 0.2;
    ctxt.lineWidth = 3*DIAGRAM_LINE_WIDTH;
    ctxt.beginPath();
    pts.forEach(cpt => {
      ctxt.lineTo(getX(cpt.x)+0.5, getY(cpt.y)+0.5);
    });
    ctxt.closePath();
    ctxt.stroke();
    ctxt.restore();

  }

  nearest_on_circuit(circuit, pt) {
    /* The closest point to pt on the given circuit, with the edge it lies on and a unit normal. */
    let diag = this.diagram;
    let best = null;
    circuit.forEach(dart => {
      let p1 = diag.verts[diag.dart_start(dart)], p2 = diag.verts[diag.dart_end(dart)];
      let dx = p2.x - p1.x, dy = p2.y - p1.y, len2 = dx*dx + dy*dy;
      let t = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x - p1.x)*dx + (pt.y - p1.y)*dy) / len2)) : 0;
      let q = new Point(p1.x + t*dx, p1.y + t*dy);
      let d = Point.dist(q, pt);
      if (best === null || d < best.dist) {
        let len = Math.sqrt(len2) || 1;
        best = {q: q, dist: d, eid: Math.abs(dart) - 1, normal: new Point(-dy/len, dx/len)};
      }
    });
    return best;
  }

  find_label(pt) {
    /* The index of the framing label near pt, or null. */
    let found = null, dist = LABEL_GRAB_RADIUS*this.zoom;
    this.diagram.annotations.forEach((a, i) => {
      if (a.kind === "framing" && Point.dist(a.pos, pt) <= dist) {
        dist = Point.dist(a.pos, pt);
        found = i;
      }
    });
    return found;
  }

  ask_framing(current) {
    let text = window.prompt("Framing for this component (for example 0, -1, <2>, 1/2).\nLeave empty to remove it.", current);
    return text === null ? null : text.trim();
  }

  mousedown(pt, e, undo_stack, ctxt) {
    pt = this.mouse_to_pt(pt);
    let tool = global_tool_state.tool;
    if (this.moving) {
      tool = "";
    }
    // In each tool, fall-through means the view movement tool should take over.
    // An explicit return is necessary to prevent this.
    if (tool === "crossing-change") {
      let closest = this.find_closest_crossing(pt);
      if (closest !== null) {
        let view = this.copy();
        let adj = view.diagram.adjs[closest];
        if (adj instanceof X) {
          adj.push(adj.shift());
        } else if (adj instanceof Virtual) {
          view.diagram.adjs[closest] = X.make(...adj);
        } else {
          assert(false);
        }
        undo_stack.push(view);
        view.draw_crossing_disk(ctxt, view.diagram.verts[closest]);
        return;
      }
    } else if (tool === "virtual-crossing") {
      let closest = this.find_closest_crossing(pt);
      if (closest !== null) {
        let view = this.copy();
        let adj = view.diagram.adjs[closest];
        if (adj instanceof X) {
          view.diagram.adjs[closest] = Virtual.make(...adj);
        } else if (adj instanceof Virtual) {
          view.diagram.adjs[closest] = X.make(...adj);
        } else {
          assert(false);
        }
        undo_stack.push(view);
        view.draw_crossing_disk(ctxt, view.diagram.verts[closest]);
        return;
      }
    } else if (tool === "toggle-orientation") {
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        let view = this.copy();
        view.diagram.reverse_orientation(circuit[0]);
        undo_stack.push(view);
        view.highlight_circuit(ctxt, circuit);
        return;
      }
    } else if (tool === "delete-component") {
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        let view = this.copy();
        view.diagram.delete_component(circuit[0]);
        undo_stack.push(view);
        return;
      }
    } else if (tool === "kirby-framing") {
      let label = this.find_label(pt);
      if (label !== null) {
        // Drag the label, or edit it on mouseup if it was not moved.
        this.dragging = {view: this.copy(), index: label, start: pt, moved: false};
        return;
      }
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        let near = this.nearest_on_circuit(circuit, pt);
        let existing = this.diagram.component_annotations(near.eid)
            .find(i => this.diagram.annotations[i].kind === "framing");
        let text = this.ask_framing(existing !== undefined ? this.diagram.annotations[existing].text : "0");
        if (text === null) return;
        let view = this.copy();
        let diag = view.diagram;
        // A component has at most one framing, and dotted circles (1-handles) have no framing.
        let drop = new Set(diag.component_annotations(near.eid));
        diag.annotations = diag.annotations.filter((a, i) => !drop.has(i));
        if (text !== "") {
          let side = Math.sign((pt.x - near.q.x)*near.normal.x + (pt.y - near.q.y)*near.normal.y);
          if (near.dist < 3) {
            // Clicked right on the curve: put the label on the outside of the component.
            let cx = 0, cy = 0;
            circuit.forEach(d => { cx += diag.verts[diag.dart_start(d)].x; cy += diag.verts[diag.dart_start(d)].y; });
            cx /= circuit.length; cy /= circuit.length;
            side = Math.sign((near.q.x - cx)*near.normal.x + (near.q.y - cy)*near.normal.y) || 1;
          }
          let off = Math.max(LABEL_OFFSET, near.dist);
          diag.annotations.push({kind: "framing", edge: near.eid, text: text,
                                 pos: new Point(near.q.x + side*off*near.normal.x, near.q.y + side*off*near.normal.y)});
        }
        undo_stack.push(view);
        return;
      }
    } else if (tool === "kirby-dot") {
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        let near = this.nearest_on_circuit(circuit, pt);
        let view = this.copy();
        let diag = view.diagram;
        let mine = diag.component_annotations(near.eid);
        let had_dot_here = mine.some(i => diag.annotations[i].kind === "dot"
                                     && Point.dist(diag.annotations[i].pos, near.q) <= 3*DOT_RADIUS*this.zoom);
        let drop = new Set(mine);
        diag.annotations = diag.annotations.filter((a, i) => !drop.has(i));
        if (!had_dot_here) {
          diag.annotations.push({kind: "dot", edge: near.eid, pos: near.q});
        }
        undo_stack.push(view);
        return;
      }
    } else if (tool.startsWith("set-color-")) {
      let color = +tool.slice("set-color-".length);
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        let view = this.copy();
        circuit.forEach(dart => {
          let edge = view.diagram.dart_edge(dart);
          edge[2] = color;
        });
        undo_stack.push(view);
        view.highlight_circuit(ctxt, circuit);
        return;
      }
    }
    // Fell through, so set up view translation.
    if (e.button === 0) {
      this.moving = pt;
    }
  }
  mousemove(pt, e, undo_stack, ctxt) {
    pt = this.mouse_to_pt(pt);
    if (this.moving) {
      let old_c = this.c.copy();
      this.c.x += (pt.x - this.moving.x) / this.zoom;
      this.c.y += (pt.y - this.moving.y) / this.zoom;
      this.paint(ctxt);
      this.c = old_c;
      return;
    }
    if (this.dragging) {
      let dr = this.dragging;
      if (Point.dist(pt, dr.start) > 3) dr.moved = true;
      let orig = this.diagram.annotations[dr.index].pos;
      dr.view.diagram.annotations[dr.index].pos = new Point(orig.x + pt.x - dr.start.x, orig.y + pt.y - dr.start.y);
      dr.view.paint(ctxt);
      return;
    }
    let tool = global_tool_state.tool;
    if (tool === "kirby-framing" || tool === "kirby-dot") {
      this.paint(ctxt);
      if (tool === "kirby-framing" && this.find_label(pt) !== null) return;
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        this.highlight_circuit(ctxt, circuit);
      }
    } else if (tool === "crossing-change") {
      this.paint(ctxt);
      let closest = this.find_closest_crossing(pt);
      if (closest !== null) {
        this.draw_crossing_disk(ctxt, this.diagram.verts[closest]);
      }
    } else if (tool === "virtual-crossing") {
      this.paint(ctxt);
      let closest = this.find_closest_crossing(pt);
      if (closest !== null) {
        this.draw_crossing_disk(ctxt, this.diagram.verts[closest]);
      }
    } else if (tool === "toggle-orientation") {
      this.paint(ctxt);
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        this.highlight_circuit(ctxt, circuit);
      }
    } else if (tool === "delete-component") {
      this.paint(ctxt);
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        this.highlight_circuit(ctxt, circuit);
      }
    } else if (tool.startsWith("set-color-")) {
      this.paint(ctxt);
      let circuit = this.find_closest_circuit(pt);
      if (circuit !== null) {
        this.highlight_circuit(ctxt, circuit);
      }
    }
  }
  mouseup(pt, e, undo_stack, ctxt) {
    pt = this.mouse_to_pt(pt);
    if (this.moving) {
      this.c.x += (pt.x - this.moving.x) / this.zoom;
      this.c.y += (pt.y - this.moving.y) / this.zoom;
      this.moving = null;
      this.paint(ctxt);
      return;
    }
    if (this.dragging) {
      let dr = this.dragging;
      this.dragging = null;
      if (dr.moved) {
        undo_stack.push(dr.view);
        return;
      }
      let a = this.diagram.annotations[dr.index];
      let text = this.ask_framing(a.text);
      if (text === null) {
        this.paint(ctxt);
        return;
      }
      let view = this.copy();
      if (text === "") {
        view.diagram.annotations.splice(dr.index, 1);
      } else {
        view.diagram.annotations[dr.index].text = text;
      }
      undo_stack.push(view);
      return;
    }
  }
  mousewheel(pt, e, undo_stack, ctxt) {
    if (this.moving) {
      // Let's not try interleaving these operations
      return;
    }
    let delta = Math.sign(e.deltaY);
    let kpt = this.mouse_to_pt(pt);
    this.zoom *= Math.pow(1.05, delta);
    let zkpt = this.mouse_to_pt(pt);
    this.c.x += (zkpt.x - kpt.x) / this.zoom;
    this.c.y += (zkpt.y - kpt.y) / this.zoom;
    this.paint(ctxt);
  }
  toolbox(undo_stack) {
    let $div = this.$div = Q.div();

    let diagram = this.diagram;

    /* Modification tools */
    Q.create("h2").append("Modification tools").appendTo($div);
    let $tools = Q.div().appendTo($div);

    let $crossing_change = Q.span(Q.span({className:"icon24-crossing"}))
        .addClass("icon-button")
        .prop("data-tool", "crossing-change")
        .prop("title", "Change crossing type")
        .appendTo($tools);

    let $toggle_virtual = Q.span(Q.span({className:"icon24-virtual-crossing"}))
        .addClass("icon-button")
        .prop("data-tool", "virtual-crossing")
        .prop("title", "Toggle virtual crossing")
        .appendTo($tools);

    let $toggle_orientation = Q.span(Q.span({className:"icon24-two-arrows"}))
        .addClass("icon-button")
        .prop("data-tool", "toggle-orientation")
        .prop("title", "Toggle component orientation")
        .appendTo($tools);

    let $eraser = Q.span(Q.span({className:"icon24-trash"}))
        .addClass("icon-button")
        .prop("data-tool", "delete-component")
        .prop("title", "Delete component")
        .appendTo($tools);

    $tools.append(Q.create("br"));
    palette.forEach((hex, i) => {
      let $b = Q.span().addClass("icon-button")
          .prop("data-tool", "set-color-" + (i+1))
          .prop("title", "Recolor component to color " + (i+1))
          .appendTo($tools);
      let $bs = Q.span(" ").addClass("icon-color")
          .css("background", hex_to_rgb(hex))
          .appendTo($b);
    });

    $tools.append(Q.create("br"));
    Q.span("n").addClass("icon-button").addClass("icon-text")
      .prop("data-tool", "kirby-framing")
      .prop("title", "Kirby diagram: click a component to set its framing; drag a label to move it, click it to edit")
      .appendTo($tools);
    Q.span("\u2022").addClass("icon-button").addClass("icon-text")
      .prop("data-tool", "kirby-dot")
      .prop("title", "Kirby diagram: click a component to make it a dotted circle (1-handle); click the dot to remove it")
      .appendTo($tools);

    this.update_tool = (toolname) => {
      $div.query(".icon-button").forEach($e => {
        let button_tool = $e.prop("data-tool");
        if (typeof button_tool === "string") {
          $e.toggleClass("active", button_tool === toolname);
        }
      });
    };
    this.update_tool(global_tool_state.tool);

    let unknown = diagram.annotations.filter(a => a.kind === "framing" && a.text === "?").length;
    if (unknown > 0) {
      Q.p(`This Kirby diagram has ${unknown} framing label${unknown > 1 ? "s" : ""} shown as "?". `
          + "Choose the n tool and click each label to type its value.")
        .addClass("kirby-note").appendTo($div);
    }

    $tools.on("click", e => {
      let el = e.target.closest('.icon-button');
      if (el) {
        let tool = Q(el).prop('data-tool');
        if (typeof tool === "string") {
          e.preventDefault();
          e.stopPropagation();
          global_tool_state.tool = tool;
          this.update_tool(tool);
        }
      }
    });

    let $mirror = Q.create("input")
        .prop("type", "button")
        .value("Mirror")
        .prop("title", "Change the types of all crossings")
        .appendTo($div);
    $mirror.on("click", e => {
      let view = this.copy();
      view.diagram.adjs.forEach(a => {
        a.push(a.shift());
      });
      undo_stack.push(view);
    });

    let $invert = Q.create("input")
        .prop("type", "button")
        .value("Invert")
        .prop("title", "Change orientations of each component")
        .appendTo($div);
    $invert.on("click", e => {
      let view = this.copy();
      view.diagram.edges.forEach(edge => {
        let t_vert = edge[0];
        edge[0] = edge[1];
        edge[1] = t_vert;
      });
      view.diagram.adjs = view.diagram.adjs.map(a => a.map(d => -d));
      undo_stack.push(view);
    });

    let $alternating = Q.create("input")
        .prop("type", "button")
        .value("Make alternating")
        .prop("title", "Change types of crossings to make an alternating diagram")
        .appendTo($div);
    $alternating.on("click", e => {
      let view = this.copy();
      view.diagram.make_alternating();
      undo_stack.push(view);
    });
    $div.append(Q.create("input", {type: "button",
                                   title: "Assign distinct colors to each component"})
                .value("Auto-color")
                .on("click", e => {
                  let view = this.copy();
                  view.diagram.auto_color(palette.length);
                  undo_stack.push(view);
                }));

    $div.append(Q.create("br"));

    let $to_drawing = Q.create("input")
        .prop("type", "button")
        .value("Convert to drawing")
        .prop("title", "Convert the diagram back into a drawing for free-form editing (no round-trip guarantee)")
        .appendTo($div);
    $to_drawing.on("click", e => {
      let canvas = document.createElement("canvas");
      canvas.width = this.width;
      canvas.height = this.height;
      let ctxt = canvas.getContext("2d");
      this.paint(ctxt, false, false);
      let view = new KnotRasterView(this.width, this.height);
      view.fromImage(ctxt.getImageData(0, 0, this.width, this.height));
      undo_stack.push(view);
    });

    $div.append(Q.create("h2").append("Isotopy tools"));

    let $beautify = Q.create("input")
        .prop("type", "button")
        .value("Beautify")
        .prop("title", "Redraw using a Tutte embedding of a subdivision of the diagram")
        .appendTo($div);
    $beautify.on("click", e => {
      let view = this.copy();
      view.diagram.beautify();
      view.reset_zoom();
      undo_stack.push(view);
    });

    let $reset_zoom = Q.create("input")
        .prop("type", "button")
        .value("Reset view")
        .prop("title", "Reset center of diagram and zoom level")
        .appendTo($div);
    $reset_zoom.on("click", e => {
      let view = this.copy();
      view.reset_zoom();
      undo_stack.push(view);
    });

    $div.append(Q.create("h2").append("Export"));

    let $export = Q.create("input")
        .prop("type", "button")
        .value("Export vector graphic")
        .prop("title", "Export a smoothed SVG or TikZ drawing of the diagram in its current projection")
        .appendTo($div);
    $export.on("click", e => {
      show_export_dialog(this.diagram);
    });

    $div.append(Q.create("hr"));

    let $laurent_types = Q.create("form", {className: "inline-form"},
                                  Q.create("label",
                                           {title: "Pretty print data using fancy HTML"},
                                           Q.create("input", {type: "radio",
                                                              name: "laurent-type",
                                                              value: "DOM"}),
                                           "Pretty"),
                                  Q.create("label",
                                           {title: "Print data in a Mathematica-compatible format"},
                                           Q.create("input", {type: "radio",
                                                              name: "laurent-type",
                                                              value: "Mathematica"}),
                                           "Mathematica"));
    $laurent_types[0].elements['laurent-type'].value = default_laurent_type;
    let laurent_handlers = [];
    $laurent_types.on("change", function (e) {
      let name = this.elements['laurent-type'].value;
      $laurent_types[0].elements['laurent-type'].value = default_laurent_type = name;
      laurent_handlers.forEach(h => h());
    });
    $div.append(Q.create("div", {style: "float: right;"},
                         $laurent_types));


    $div.append(Q.create("h2").append("Diagram information"));

    let virtual_crossings = this.diagram.virtual_crossing_number();
    let virtual_genus = this.diagram.virtual_genus();

    let $idiv = Q.create("div").prop("id", "diag-info").appendTo($div);
    {
      let $table = Q.create("table", {className:"diag-props"});
      $idiv.append($table);

      $table.append(Q.create("tr",
                             Q.create("th", "Crossings:"),
                             Q.create("td", ''+this.diagram.crossing_number())));

      if (virtual_crossings > 0) {
        $table.append(Q.create("tr",
                               Q.create("th", "Virtual crossings:"),
                               Q.create("td", ''+virtual_crossings)));
      }

      $table.append(Q.create("tr",
                             Q.create("th", "Components:"),
                             Q.create("td", ''+this.diagram.num_components())));

      $table.append(Q.create("tr",
                             Q.create("th", "Writhe:"),
                             Q.create("td", ''+this.diagram.writhe())));

      $table.append(Q.create("tr",
                             Q.create("th", "Bridges:"),
                             Q.create("td", ''+this.diagram.bridge_number())));

      if (virtual_crossings > 0) {
        $table.append(Q.create("tr", {title: "The virtual genus for this diagram"},
                               Q.create("th", "Virtual genus:"),
                               Q.create("td", ''+virtual_genus)));
      }

      if (virtual_crossings === 0) {
        $table.append(Q.create("tr", {title: "The canonical Seifert genus for this diagram"},
                               Q.create("th", "Can. genus:"),
                               Q.create("td", ''+this.diagram.genus())));
      }

      let props = [];
      if (diagram.is_alternating()) {
        props.push("alternating");
      }

      if (virtual_genus === 0) {
        let turaev = this.diagram.turaev();
        $table.append(Q.create("tr",
                               Q.create("th", "Turaev genus:"),
                               Q.create("td", ''+turaev.genus)));
        if (turaev.plus && turaev.minus) {
          props.push("adequate");
        } else if (turaev.plus) {
          props.push("plus-adequate");
        } else if (turaev.minus) {
          props.push("minus-adequate");
        }
      }

      $table.append(Q.create("tr",
                             Q.create("th", "Properties:"),
                             Q.create("td", props.length > 0 ? props.join(", ") : Q.create("em", "none"))));

      let $lm = Q.create("details",
                         {title: "Pairwise linking numbers between colored components. Self linking number is writhe."},
                         Q.create("summary", "Linking matrix"))
          .appendTo($idiv);
      attach_details_handler("linking-matrix", $lm);
      {
        let matrix = this.diagram.linking_matrix();
        let comps = Array.from(matrix.keys());
        comps.sort((a, b) => a-b);
        let $table = Q.create("table").addClass("linking-matrix");
        comps.forEach(j => {
          let $tr = Q.create("tr").appendTo($table);
          comps.forEach(i => {
            let $td = Q.create("td").appendTo($tr);
            $td.append(''+(matrix.get(j).get(i)||0));
            if (i === j) {
              $td.prop("style").color = "white";
              $td.prop("style").background = hex_to_rgb(palette[i-1]);
            }
          });
        });
        $lm.append($table);
      }
    }

    if (virtual_genus === 0) {
      let $sf = Q.create("details",
                         {title:"There is one Seifert linking matrix per connected component of the diagram."},
                         Q.create("summary", "Seifert form"))
          .appendTo($idiv);

      attach_details_handler("seifert-matrix", $sf);

      let $sf_div = Q.create("div").appendTo($sf);

      function mk_seifert_matrix() {
        $sf_div.empty();
        switch (default_laurent_type) {
        case "DOM":
          diagram.seifert_form().forEach(matrix => {
            let $table = Q.create("table", {className:"seifert-matrix"});
            matrix.forEach(row => {
              let $tr = Q.create("tr").appendTo($table);
              row.forEach(c => {
                $tr.append(Q.create("td", ''+c));
              });
            });
            $sf_div.append($table);
          });
          break;
        case "Mathematica":
        default:
          diagram.seifert_form().forEach(matrix => {
            let m = '{' + matrix.map(row => '{' + row.map(c => ''+c).join(', ') + '}').join(', ') + '}';
            $sf_div.append(Q.create('div').append(m));
          });
          break;
        }
      }

      mk_seifert_matrix();
      laurent_handlers.push(mk_seifert_matrix);
    }

    // let $sig;
    // $table.append(Q.create("tr", {title: "The program currently uses floating point arithmetic to compute eigenvalues, hence the warning."},
    //                        Q.create("th", "Signature:"),
    //                        $sig = Q.create("td", ''+the_signature+" ",
    //                                        Q.create("em", "(warning: estimated)"))));


    let $pd = Q.create("textarea")
        .attr("readonly", true)
        .addClass("code-data");
    let $pdtypes = Q.create("form", {className: "inline-form"},
                            Q.create("label",
                                     Q.create("input", {type: "radio",
                                                        name: "pd-type",
                                                        value: "KnotTheory"}),
                                     "KnotTheory"),
                            Q.create("label",
                                     Q.create("input", {type: "radio",
                                                        name: "pd-type",
                                                        value: "KnotTheory-oriented"}),
                                     "Oriented KnotTheory"),
                            Q.create("label",
                                     Q.create("input", {type: "radio",
                                                        name: "pd-type",
                                                        value: "SnapPy"}),
                                     "SnapPy"),
                           );
    function pd_change(name) {
      $pdtypes[0].elements['pd-type'].value = default_pd_type = name;
      try {
        if (name === "KnotTheory") {
          $pd.value(diagram.get_pd().toMathematica());
        } else if (name === "KnotTheory-oriented") {
          $pd.value(diagram.get_pd(true).toMathematica());
        } else if (name === "SnapPy") {
          $pd.value(diagram.get_pd().toSnappy());
        }
      } catch (x) {
        $pd.value("" + x);
      }
    }
    $pdtypes.on("change", function (e) {
      let name = this.elements['pd-type'].value;
      pd_change(name);
    });
    $idiv.append(Q.create("p")
                 .append("PD: ")
                 .append($pdtypes, Q.create("br"), $pd));
    pd_change(default_pd_type);

    if (virtual_genus === 0) {
      let dt = diagram.get_dt();
      if (dt) {
        $idiv.append(Q.create("p", {title: "The Dowker-Thistlethwaite code for the knot."})
                     .append("DT: " + toString(dt)));
      }
    }

    function laurent_invariant(promise, div, variable="t", exp_divisor=1) {
      div.append(Q.create("em", "calculating..."));
      promise.then(poly => {
        let e = null;
        function show_poly() {
          div.empty();
          switch (default_laurent_type) {
          case "DOM":
            div.append(e.toDOM());
            break;
          case "Mathematica":
          default:
            div.append(e.toMathematica());
            break;
          }
        }
        if (poly) {
          e = poly.toExpr(variable, exp_divisor);
          show_poly();
          laurent_handlers.push(show_poly);
        } else {
          div.empty().append("n/a");
        }
      }, err => {
        console.log(err);
        div.addClass("calc-error");
        div.append('Error: '+err);
      });
    }

    function mlaurent_invariant(promise, div, variables, exp_divisor=1) {
      div.append(Q.create("em", "calculating..."));
      promise.then(poly => {
        let split = expr.make_int_const(0);
        poly.coeffs().forEach(pair => {
          split = expr.plus(split,
                            expr.times(pair[0].toExpr(variables, exp_divisor),
                                       pair[1].toExpr(variables)));
        });
        function show_poly() {
          div.empty();
          switch (default_laurent_type) {
          case "DOM":
            div.append(split.toDOM());
            break;
          case "Mathematica":
          default:
            div.append(split.toMathematica());
            break;
          }
        }
        if (poly) {
          show_poly();
          laurent_handlers.push(show_poly);
        } else {
          div.append("n/a");
        }
      }, err => {
        console.log(err);
        div.addClass("calc-error");
        div.append('Error: '+err);
      });
    }

    if (this.calculate_invariants) {
      var $kb_div;
      $idiv.append(Q.create("p")
                   .append("Kauffman bracket:")
                   .append($kb_div = Q.create("div")));
      laurent_invariant(get_invariant("kauffman_bracket", this.diagram), $kb_div, "A");
    }

    if (this.calculate_invariants) {
      $idiv.append(Q.create("h2").append("Identification"));
      let $ident = Q.create("p").appendTo($idiv);
      get_invariant('identify_link', this.diagram).then(
        res => {
          if (res.names.length === 0) {
            $ident.append("Unknown link");
          } else {
            $ident.append("Candidates: ");
            res.names.forEach((c, i) => {
              if (i > 0) {
                $ident.append(", ");
              }
              if (c.katlas) {
                $ident.append(Q.create("a", {href: c.katlas,
                                             target: "_blank"},
                                       c.name));
              } else {
                $ident.append(c.name);
              }
            });
          }
          if (res.incomplete) {
            $ident.append(" (warning: possibly incomplete)");
          }
        },
        err => {
          console.error(err);
          $ident.addClass("calc-error");
          $ident.append('Error: '+err);
        }
      );
    }

    if (this.calculate_invariants) {
      $idiv.append(Q.create("h2").append("Invariants"));

      {
        let $table = Q.create("table", {className:"diag-props"});
        $idiv.append($table);

        let $det;
        $table.append(Q.create("tr",
                               Q.create("th", "Determinant:"),
                               $det = Q.create("td")));

        (async function () {
          let poly = await get_invariant("alexander_poly", diagram, 0);
          let coeffs = poly.coeffs();
          let det = 0;
          for (let i = 0; i < coeffs.length; i++) {
            det += coeffs[i] * (2 * (i % 2) - 1);
          }
          $det.append('' + Math.abs(det));
        })();


        let next_cjones = 1;

        let $nextJones = Q.create("input")
            .prop("type", "button")
            .value("Next")
            .prop("title", "Compute next cabled Jones polynomial");
        $nextJones.on("click", e => {
          do_cjones(next_cjones++);
        });

        let $jones = Q.create("div");
        $idiv.append(Q.create("p")
                     .append("(Cabled) Jones polynomials: ")
                     .append($nextJones)
                     .append($jones));

        const do_cjones = (i) => {
          next_cjones = i + 1;
          let $cj = Q.create("span");
          $jones.append(Q.create("div").append("V", Q.create("sub", i), " = ", $cj));
          laurent_invariant(get_invariant('cabled_jones_poly', this.diagram, i), $cj, "t", -4);
        };

        do_cjones(1);

        if (virtual_genus > 0) {

          let next_carrow = 1;

          let $next_carrow = Q.create("input")
              .prop("type", "button")
              .value("Next")
              .prop("title", "Compute next cabled Arrow polynomial");
          $next_carrow.on("click", e => {
            do_carrow(next_carrow++);
          });

          let $carrow = Q.create("div");
          $idiv.append(Q.create("p")
                       .append("(Cabled) Arrow polynomials: ")
                       .append($next_carrow)
                       .append($carrow));

          const do_carrow = (i) => {
            next_carrow = i + 1;
            let $cj = Q.create("span");
            $carrow.append(Q.create("div").append("A", Q.create("sub", i), " = ", $cj));
            function arrow_varnames_t(i) {
              if (i === 0) {
                return "t";
              } else {
                return "K" + i;
              }
            }
            mlaurent_invariant(get_invariant('cabled_arrow_poly', this.diagram, i), $cj, arrow_varnames_t, -4);
          };

          do_carrow(1);

        }


        if (0) {
          let wp = get_invariant(this.diagram, 'wirtinger_presentation');
          let gens = Q.create("div").append("Generators: ");
          wp.gens.forEach((g, i) => {
            if (i > 0) {
              gens.append(", ");
            }
            gens.append(showGen(g));
          });
          let rels = Q.create("div").append("Relations: ");
          wp.rels.forEach((rel, i) => {
            if (i > 0) {
              rels.append(", ");
            }
            rels.append(showRel(rel));
          });
          $idiv.append(Q.create("p")
                       .append("Wirtinger presentation:")
                       .append(gens)
                       .append(rels));
          function showGen(g) {
            let s = Q.create("span").append(g[0]);
            s.append(Q.create("sub").append(g.slice(1)));
            return s;
          }
          function showRel(rel) {
            let s = Q.create("span");
            for (let i = 0; i < rel.length; i += 2) {
              s.append(showGen(rel[i]));
              if (rel[i+1] !== 1) {
                s.append(Q.create("sup").append(''+rel[i+1]));
              }
            }
            return s;
          }
        }

        if (virtual_genus === 0) {
          let $conway_poly;
          $idiv.append(Q.create("p")
                       .append("Conway potential:")
                       .append($conway_poly = Q.create("div")));
          laurent_invariant(get_invariant("conway_poly", diagram), $conway_poly, "z");
        }

        let $alex_polys = Q.create("p").append("Alexander polynomials:").appendTo($idiv);
        (async function () {
          try {
            for (let n = 0; ; n++) {
              let poly = await get_invariant("alexander_poly", diagram, n);
              if (n >= 1 && poly.equal(Laurent.unit)) {
                break;
              }
              $alex_polys.append(Q.create("br"));
              $alex_polys.append("\u0394");
              $alex_polys.append(Q.create("sup").append(''+n));
              $alex_polys.append("(t) = "); //, poly.toDOM("t"));
              let $span = Q.create("span").appendTo($alex_polys);
              laurent_invariant(new Promise((resolve) => resolve(poly)),
                                $span);
            }
          } catch (x) {
            $alex_polys.append(Q.create("div", {className: "calc-error"}, ''+x));
            throw x;
          }
        })();

        let $alex_mod = Q.create("details",
                                 {title:"Mildly simplified (not normalized since Z[t,t^-1] is not a PID)"},
                                 Q.create("summary", "An Alexander module presentation matrix:"))
            .appendTo($idiv);
        attach_details_handler("alexander-module", $alex_mod);
        (async function () {
          let matrix = await get_invariant('alexander_module', diagram);
          let $table = Q.create("table").addClass("alexander-matrix");
          matrix.forEach(row => {
            let $tr = Q.create("tr").appendTo($table);
            row.forEach(entry => {
              let $td = Q.create("td").appendTo($tr);
              $td.append(entry.toExpr("t").toDOM());
            });
          });
          $alex_mod.append($table);
          $alex_mod.append(Q.create("em").append("(" + matrix.length + " generator(s))"));
        })();

      }
    } else {
      //$idiv.append(Q.create("br"));
      let $calc = Q.create("input")
          .prop("type", "button")
          .value("Calculate invariants")
          .prop("title", "Calculate invariants and identify the knot or link")
          .appendTo($idiv);
      $calc.on("click", e => {
        undo_stack.push(this.copy(true));
      });
    }
    
    return $div;
  }

  paint(ctxt, with_arrows=true, with_virtual=true) {
    ctxt.save();
    ctxt.fillStyle = "white";
    ctxt.fillRect(0, 0, this.width, this.height);

    let getX = (x) => {
      return x/this.zoom+this.c.x;
    };
    let getY = (y) => {
      return y/this.zoom+this.c.y;
    };

    let diag = this.diagram;

    let seen_darts = new Set;

    let visit_dart = (dart) => {
      if (seen_darts.has(dart)) return;

      // locate beginning of path
      function opp_is_under(d) {
        /* Is the opposite of the dart an under-dart? */
        d = diag.opp_dart(d);
        return diag.dart_adj(d) instanceof X && !diag.dart_is_over(d);
      }
      // Switch to opposite orientation if needed, then walk until we get to beginning of arc.
      if (diag.dart_start(dart) === diag.dart_edge(dart)[0]) {
        dart = diag.opp_dart(dart);
      }
      let d = dart;
      while (!opp_is_under(d)) {
        d = diag.through_dart(d);
        if (d === dart) break;
      }
      dart = diag.opp_dart(d);
      // now dart is beginning of an arc (or some random dart from a loop)

      let path = [];
      let loop = false;
      d = dart;
      while (true) {
        seen_darts.add(d);
        seen_darts.add(diag.opp_dart(d));
        path.push(diag.verts[diag.dart_start(d)]);
        if (opp_is_under(d)) {
          path.push(diag.verts[diag.dart_end(d)]);
          break;
        }
        if (path.length > 1 && d === dart) {
          loop = true;
          break;
        }
        d = diag.through_dart(d);
      }

      if (!loop) {
        let to_remove = CROSSING_GAP * this.zoom;
        while (to_remove > 0 && path.length >= 2) {
          let d = Point.dist(path[0], path[1]);
          if (d <= to_remove) {
            to_remove -= d;
            path.shift();
          } else {
            path[0] = point_along(path[0], path[1], to_remove/d);
            break;
          }
        }
        to_remove = CROSSING_GAP * this.zoom;
        while (to_remove > 0 && path.length >= 2) {
          let d = Point.dist(path[path.length-2], path[path.length-1]);
          if (d <= to_remove) {
            to_remove -= d;
            path.pop();
          } else {
            path[path.length-1] = point_along(path[path.length-1], path[path.length-2], to_remove/d);
            break;
          }
        }
      }

      ctxt.beginPath();
      ctxt.moveTo(getX(path[0].x)+0.5, getY(path[0].y)+0.5);
      for (let i = 1; i < path.length; i++) {
        let v = path[i];
        ctxt.lineTo(getX(v.x)+0.5, getY(v.y)+0.5);
      }
      ctxt.strokeStyle = hex_to_rgb(palette[diag.dart_edge(dart)[2]-1]);
      ctxt.lineWidth = DIAGRAM_LINE_WIDTH;
      ctxt.lineCap = "round";
      ctxt.stroke();

      // arrow head
      if (with_arrows) {
        let p = path[path.length-1];
        let dx = 0, dy = 0;
        let dist = 5;
        for (let i = path.length-2; i >= 0 && dist > 0; i--) {
          let p1 = path[i], p2 = path[i+1];
          dx += p2.x - p1.x;
          dy += p2.y - p1.y;
          dist -= Point.dist(p1, p2);
        }
        let norm = Math.sqrt(dx*dx + dy*dy);
        if (norm > 0) {
          dx /= norm;
          dy /= norm;
          ctxt.beginPath();
          function f_x(x, y) {
            // x is in direction of arrow tip
            return getX(p.x) + dx*x - dy*y + 0.5;
          }
          function f_y(x, y) {
            return getY(p.y) + dy*x + dx*y + 0.5;
          }
          ctxt.moveTo(f_x(-5, 2), f_y(-5, 2));
          ctxt.lineTo(f_x(0, 0), f_y(0, 0));
          ctxt.lineTo(f_x(-5, -2), f_y(-5, -2));
          ctxt.stroke();
        }
      }
    };

    diag.edges.forEach((e, i) => {
      visit_dart(i+1);
    });

    // draw virtual crossing circles
    if (with_virtual) {
      diag.adjs.forEach((adj, vid) => {
        if (adj instanceof Virtual) {
          let pt = diag.verts[vid];
          ctxt.beginPath();
          ctxt.arc(getX(pt.x)+0.5, getY(pt.y)+0.5, VIRTUAL_RADIUS, 0, 2*Math.PI);
          ctxt.stroke();
        }
      });
    }

    diag.annotations.forEach(a => {
      let x = getX(a.pos.x)+0.5, y = getY(a.pos.y)+0.5;
      if (a.kind === "dot") {
        ctxt.beginPath();
        ctxt.arc(x, y, DOT_RADIUS, 0, 2*Math.PI);
        ctxt.fillStyle = hex_to_rgb(palette[diag.edges[a.edge][2]-1]);
        ctxt.fill();
      } else {
        ctxt.font = "16px serif";
        ctxt.textAlign = "center";
        ctxt.textBaseline = "middle";
        ctxt.fillStyle = "black";
        ctxt.fillText(plain_label(a.text), x, y);
      }
    });

    if (0) {
      ctxt.fillStyle = "white";
      ctxt.globalAlpha = 1.0;
      diag.verts.forEach(pt => {
        ctxt.fillRect(getX(pt.x), getY(pt.y), 2, 2);
      });
    }

    ctxt.restore();
  }
}
