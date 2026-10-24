import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[3];
test(name, replay);
