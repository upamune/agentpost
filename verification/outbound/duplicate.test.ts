import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[0];
test(name, replay);
