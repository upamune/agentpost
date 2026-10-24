import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[4];
test(name, replay);
