import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[6];
test(name, replay);
