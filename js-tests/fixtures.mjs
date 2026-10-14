import { Scene } from "../app/scene.js";

/** The classic CSG demo as an editable tree. */
export function demoScene() {
  const scene = new Scene();
  const body = scene.add("intersect", { name: "Body" });
  scene.add("cube", {}, body.id);
  scene.add("sphere", { params: { radius: 1.35 } }, body.id);
  const part = scene.combine("subtract", [body.id]);
  part.name = "Part";
  const holes = scene.add("union", { name: "Holes" }, part.id);
  const rod = { radius: 0.6, height: 4, slices: 32, axis: "y" };
  scene.add("cylinder", { params: rod, name: "Hole Y" }, holes.id);
  scene.add("cylinder", { params: rod, name: "Hole Z", transform: { rotation: [90, 0, 0] } }, holes.id);
  scene.add("cylinder", { params: rod, name: "Hole X", transform: { rotation: [0, 0, 90] } }, holes.id);
  return scene;
}
