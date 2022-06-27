import { defineComponent } from 'vue'

export default defineComponent({
  props: {
    label: {
      type: Function
    }
  },
  render() {
    return <p>{this.label!()}</p>
  }
})
