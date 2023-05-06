rule = {
  matches = {
    {
      { "node.name", "equals", "easyeffects_sink" },
    },
  },
  apply_properties = {
	["device.description"] = "Test",
    ["node.disabled"] = true,
  },
}

table.insert(alsa_monitor.rules,rule)
